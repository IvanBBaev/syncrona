# Homebrew formula for the SyncroNow AI CLI (syncrona).
#
# This is the source-of-truth template kept in the main repo. The release
# workflow (.github/workflows/release.yml) copies it into the homebrew-tap repo
# and fills in `url` + `sha256` for the published npm tarball on every tagged
# core release. The placeholders below are intentionally invalid until the first
# publish (npm publish is owner-gated: scope ownership + 2FA).
class Syncrona < Formula
  desc "Local-first CLI + AI (MCP) toolchain for ServiceNow scoped-app development"
  homepage "https://github.com/IvanBBaev/syncrona"
  # Filled by the release workflow from the published tarball:
  #   https://registry.npmjs.org/syncrona/-/syncrona-<version>.tgz
  url "https://registry.npmjs.org/syncrona/-/syncrona-0.0.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "GPL-3.0-or-later"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "syncrona", shell_output("#{bin}/syncrona --help 2>&1", 0)
  end
end
