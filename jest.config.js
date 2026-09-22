module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: "test/.*\.e2e-spec\.ts$",
  transform: { "^.+\.ts$": ["ts-jest", { tsconfig: "tsconfig.json", diagnostics: false }] },
  testEnvironment: "node",
  globalSetup: "<rootDir>/test/global-setup.js",
  setupFiles: ["<rootDir>/test/env.js"],
  testTimeout: 30000,
};
