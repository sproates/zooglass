const majorVersion = Number(process.versions.node.split(".")[0]);

if (majorVersion !== 26) {
  console.error(
    `Node.js 26 is required. Current version: ${process.version}`,
  );
  process.exit(1);
}
