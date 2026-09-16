/**
 * Sensitive File Policy implementation.
 * Ensures consistent sensitive file filtering across all workspace actions.
 */

/**
 * Checks whether a given relative POSIX path matches sensitive file rules.
 * Paths are expected to use forward slashes and no leading slash.
 */
export function isSensitivePath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }
  const cleanPath = relativePath.replace(/^(\.\/|\/)+/, "");
  const segments = cleanPath.split("/");
  const fileName = segments[segments.length - 1] || "";

  // Whitelist .env.example and .env.template (exact match or anywhere in hierarchy)
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === ".env.example" || lowerFileName === ".env.template") {
    return false;
  }

  // Deny .git directory and any files inside .git
  if (segments.includes(".git")) {
    return true;
  }

  // Deny .env, .env.*
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }

  // Deny *.pem, *.key
  if (fileName.endsWith(".pem") || fileName.endsWith(".key")) {
    return true;
  }

  // Deny id_rsa, id_rsa.*
  if (fileName === "id_rsa" || fileName.startsWith("id_rsa.")) {
    return true;
  }

  // Deny .npmrc, .pypirc
  if (fileName === ".npmrc" || fileName === ".pypirc") {
    return true;
  }

  return false;
}

/**
 * Common ripgrep ignore globs to exclude sensitive files directly at the search engine level.
 */
export function getRipgrepIgnoreGlobs(): string[] {
  return [
    "!.git",
    "!.git/**",
    "!**/.git/**",
    "!.env",
    "!.env.*",
    "!**/.env",
    "!**/.env.*",
    "!*.pem",
    "!**/*.pem",
    "!*.key",
    "!**/*.key",
    "!id_rsa",
    "!id_rsa.*",
    "!**/id_rsa",
    "!**/id_rsa.*",
    "!.npmrc",
    "!**/.npmrc",
    "!.pypirc",
    "!**/.pypirc",
    // Whitelisted exceptions explicitly allowed back
    ".env.example",
    "**/.env.example",
    ".env.template",
    "**/.env.template",
  ];
}
