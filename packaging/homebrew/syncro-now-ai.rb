# Homebrew formula for the SyncroNow AI CLI (@syncro-now-ai/core).
#
# This is the source-of-truth template kept in the main repo. The release
# workflow (.github/workflows/release.yml) copies it into the homebrew-tap repo
# and fills in `url` + `sha256` for the published npm tarball on every tagged
# core release. The placeholders below are intentionally invalid until the first
# publish (npm publish is owner-gated: scope ownership + 2FA).
class SyncroNowAi < Formula
  desc "Local-first CLI + AI (MCP) toolchain for ServiceNow scoped-app development"
  homepage "https://github.com/LeassTaTT/syncrona"
  # Filled by the release workflow from the published tarball:
  #   https://registry.npmjs.org/@syncro-now-ai/core/-/core-<version>.tgz
  url "https://registry.npmjs.org/@syncro-now-ai/core/-/core-0.0.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "GPL-3.0-or-later"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "syncro-now-ai", shell_output("#{bin}/syncro-now-ai --help 2>&1", 0)
  end
end
