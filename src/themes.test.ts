import { describe, expect, test } from "bun:test";
import { savedTheme, themeGroups, themes } from "./themes";

describe("theme preference", () => {
  test("keeps existing and variant selections, and falls back from an unknown value", () => {
    expect(savedTheme("light")).toBe("light");
    expect(savedTheme("dark")).toBe("dark");
    expect(savedTheme("catppuccin-mocha")).toBe("catppuccin-mocha");
    expect(savedTheme("rose-pine-moon")).toBe("rose-pine-moon");
    expect(savedTheme("tokyo-night-day")).toBe("tokyo-night-day");
    expect(savedTheme("monokai-spectrum")).toBe("monokai-spectrum");
    expect(savedTheme("github-dark-dimmed")).toBe("github-dark-dimmed");
    expect(savedTheme("github-light-colorblind")).toBe("github-light");
    expect(savedTheme("github-dark-tritanopia")).toBe("github-dark");
    expect(savedTheme("unknown-theme")).toBe("dark");
    expect(savedTheme(null)).toBe("dark");
  });

  test("exposes all variant choices with the right light or dark mode", () => {
    const choices = themeGroups.flatMap((group) => group.options);
    expect(choices).toHaveLength(24);
    expect(new Set(choices).size).toBe(choices.length);
    expect(choices.filter((id) => themes[id].mode === "light")).toEqual([
      "light", "catppuccin-latte", "rose-pine-dawn", "tokyo-night-day", "github-light", "github-light-high-contrast",
    ]);
  });
});
