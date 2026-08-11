const { createPublicClient, createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

// --- CONFIG ---
const RPC_URL = "https://coston2-api.flare.network/ext/C/rpc";
const VERIFIER_URL =
  "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest";
const API_KEY = "00000000-0000-0000-0000-000000000000";
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, transport: http(RPC_URL) });
async function prepareRequest() {
  const requestBody = {
    url: "https://data-api.binance.vision/api/v3/klines",
    httpMethod: "GET",
    headers: "{}",
    queryParams: JSON.stringify({
      symbol: "SOLUSDT",
      interval: "1m",
      //startTime: process.env.MARKET_DEADLINE_MS,
      startTime: "1710000000000",
      limit: "1",
    }),
    body: "{}",
    postProcessJq:
      '{ price: ((.[0][4] | tonumber) * 100000000 | tostring | split(".")[0] | tonumber) }',
    abiSignature: JSON.stringify({
      type: "tuple",
      components: [
        {
          name: "price",
          type: "uint256",
        },
      ],
    }),
  };

  const body = {
    attestationType: toBytes32("Web2Json"),
    sourceId: toBytes32("PublicWeb2"),
    requestBody,
  };

  const res = await fetch(VERIFIER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.status !== "VALID") {
    throw new Error("prepareRequest failed: " + JSON.stringify(data));
  }

  console.log("Step 1 OK — abiEncodedRequest ready");
  console.log("abiEncodedRequest:", data.abiEncodedRequest);
  return data.abiEncodedRequest;
}

function toBytes32(text) {
  return "0x" + Buffer.from(text).toString("hex").padEnd(64, "0");
}
async function submitRequest(abiEncodedRequest) {
  const registryAbi = [
    {
      type: "function",
      name: "getContractAddressByName",
      stateMutability: "view",
      inputs: [{ type: "string" }],
      outputs: [{ type: "address" }],
    },
  ];

  const readAddr = (name) =>
    publicClient.readContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: "getContractAddressByName",
      args: [name],
    });

  const fdcHubAddr = await readAddr("FdcHub");
  const feeConfigAddr = await readAddr("FdcRequestFeeConfigurations");
  const fsmAddr = await readAddr("FlareSystemsManager");
  console.log("FdcHub:", fdcHubAddr);

  const fee = await publicClient.readContract({
    address: feeConfigAddr,
    abi: [
      {
        type: "function",
        name: "getRequestFee",
        stateMutability: "view",
        inputs: [{ type: "bytes" }],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "getRequestFee",
    args: [abiEncodedRequest],
  });
  console.log("Fee (wei):", fee.toString());

  const txHash = await walletClient.writeContract({
    address: fdcHubAddr,
    abi: [
      {
        type: "function",
        name: "requestAttestation",
        stateMutability: "payable",
        inputs: [{ type: "bytes" }],
        outputs: [],
      },
    ],
    functionName: "requestAttestation",
    args: [abiEncodedRequest],
    value: fee,
  });
  console.log("Submitted, tx:", txHash);
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  const roundId = await publicClient.readContract({
    address: fsmAddr,
    abi: [
      {
        type: "function",
        name: "getCurrentVotingEpochId",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint32" }],
      },
    ],
    functionName: "getCurrentVotingEpochId",
  });
  console.log("Step 2 OK — round:", roundId.toString());

  return Number(roundId);
}
async function waitForFinalization(seconds = 180) {
  console.log(`Step 3 — waiting ${seconds}s for the round to finalize...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  console.log("Step 3 OK — done waiting");
}
async function getProof(roundId, abiEncodedRequest) {
  const DA_LAYER_URL =
    "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round";

  const res = await fetch(DA_LAYER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
    body: JSON.stringify({
      votingRoundId: roundId,
      requestBytes: abiEncodedRequest,
    }),
  });

  const data = await res.json();
  console.log("Step 4 — DA layer status:", res.status);
  console.log("Step 4 — response:", JSON.stringify(data, null, 2));

  if (!data || !data.proof) {
    throw new Error(
      "No proof found — providers likely couldn't fetch this API, or round is off.",
    );
  }

  console.log("Step 4 OK — proof received");
  return data;
}
async function main() {
  const abiEncodedRequest = await prepareRequest(); // Step 1
  const roundId = await submitRequest(abiEncodedRequest); // Step 2
  await waitForFinalization(180); // Step 3
  const proof = await getProof(roundId, abiEncodedRequest); // Step 4
  console.log("ALL DONE — full proof:", JSON.stringify(proof, null, 2));
  console.log("SOL Price:", proof.proof);
  //added xtra
  return proof;
}
// added xtra:
// module.exports = { main };

// main().catch((e) => {
//   console.error("FAILED:", e.message);
//   process.exit(1);
// });
module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  });
}
