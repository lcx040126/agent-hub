const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    nodeMode: process.env.ELECTRON_RUN_AS_NODE,
    input: Buffer.concat(chunks).toString("utf8"),
    arguments: process.argv.slice(2),
  }));
});
