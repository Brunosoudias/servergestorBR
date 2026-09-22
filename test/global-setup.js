const { execSync } = require("child_process");
module.exports = async () => {
  require("./env.js");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });
};
