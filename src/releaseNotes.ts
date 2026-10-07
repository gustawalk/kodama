import v120 from "../docs/releases/v1.2.0.md?raw";
import v110 from "../docs/releases/v1.1.0.md?raw";
import v100 from "../docs/releases/v1.0.0.md?raw";
import v010 from "../docs/releases/v0.1.0.md?raw";

const parseNotes = (source: string) => {
  const lines = source.trim().split(/\r?\n/);
  return {
    version: lines[0].replace(/^# Kodama /, ""),
    changes: lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
  };
};

export const releaseNotes = [v120, v110, v100, v010].map(parseNotes);
