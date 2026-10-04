import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function generateUpdaterManifest({ assetsDirectory, releaseTag, repository, notesFile }) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(releaseTag)) {
    throw new Error(`Invalid release tag: ${releaseTag}`);
  }
  const files = await readdir(assetsDirectory, { recursive: true });
  const notes = (await readFile(notesFile, "utf8")).trim();
  if (!notes) throw new Error("Release notes must not be empty.");

  async function platformAsset(suffix) {
    const matches = files.filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} updater asset, found ${matches.length}.`);
    const file = matches[0];
    const signature = (await readFile(path.join(assetsDirectory, `${file}.sig`), "utf8")).trim();
    if (!signature) throw new Error(`Empty signature for ${file}.`);
    return {
      signature,
      url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(path.basename(file))}`,
    };
  }

  return {
    version: releaseTag.slice(1),
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": await platformAsset(".exe"),
      "linux-x86_64": await platformAsset(".AppImage"),
      "darwin-aarch64": await platformAsset(".app.tar.gz"),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assetsDirectory = process.env.RELEASE_ASSETS_DIR;
  const releaseTag = process.env.RELEASE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  const notesFile = process.env.RELEASE_NOTES_FILE;
  const outputPath = process.env.UPDATER_MANIFEST_PATH ?? "updater.json";
  if (!assetsDirectory || !releaseTag || !repository || !notesFile) {
    throw new Error("RELEASE_ASSETS_DIR, RELEASE_TAG, GITHUB_REPOSITORY, and RELEASE_NOTES_FILE are required.");
  }
  const manifest = await generateUpdaterManifest({ assetsDirectory, releaseTag, repository, notesFile });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
