import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";

describe("release updater manifest", () => {
  test("maps signed installers and release notes to all published platforms", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kodama-release-"));
    try {
      for (const file of ["Kodama-setup.exe", "Kodama.AppImage", "Kodama.app.tar.gz"]) {
        await writeFile(path.join(directory, file), "bundle");
        await writeFile(path.join(directory, `${file}.sig`), `${file}-signature`);
      }
      const notesFile = path.join(directory, "notes.md");
      await writeFile(notesFile, "Fixed tab restoration.\n");
      const result = await generateUpdaterManifest({
        assetsDirectory: directory,
        releaseTag: "v0.2.0",
        repository: "gustawalk/kodama",
        notesFile,
      });
      expect(result.version).toBe("0.2.0");
      expect(result.notes).toBe("Fixed tab restoration.");
      expect(result.platforms["windows-x86_64"]).toEqual({
        signature: "Kodama-setup.exe-signature",
        url: "https://github.com/gustawalk/kodama/releases/download/v0.2.0/Kodama-setup.exe",
      });
      expect(result.platforms["linux-x86_64"].signature).toBe("Kodama.AppImage-signature");
      expect(result.platforms["darwin-aarch64"].signature).toBe("Kodama.app.tar.gz-signature");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails instead of publishing a manifest without a signed platform", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kodama-release-"));
    try {
      const notesFile = path.join(directory, "notes.md");
      await writeFile(notesFile, "Release notes");
      await expect(
        generateUpdaterManifest({ assetsDirectory: directory, releaseTag: "v0.2.0", repository: "gustawalk/kodama", notesFile }),
      ).rejects.toThrow("Expected one .exe updater asset");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
