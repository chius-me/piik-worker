import { expect, test } from "vitest";
import {
  apiErrorKey,
  messages,
  preferredLanguage,
  translate,
} from "../../src/client/i18n";

test("keeps a saved language ahead of browser preferences", () => {
  expect(preferredLanguage("zh", "en-US")).toBe("zh");
  expect(preferredLanguage("en", "zh-CN")).toBe("en");
  expect(preferredLanguage(null, "en-GB")).toBe("en");
  expect(preferredLanguage("invalid", "zh-TW")).toBe("zh");
});

test("English system copy contains no Chinese", () => {
  for (const key of Object.keys(messages) as (keyof typeof messages)[]) {
    expect(translate(key, "en").trim(), key).not.toBe("");
    expect(translate(key, "en"), key).not.toMatch(/\p{Script=Han}/u);
  }
});

test("maps server errors into the chosen language without exposing raw messages", () => {
  expect(translate(apiErrorKey("KICKED"), "en")).toBe("The host removed you.");
  expect(translate(apiErrorKey("INVITE_INVALID"), "zh")).toBe(
    "邀请已失效，请索取新链接。",
  );
  expect(apiErrorKey("FUTURE_ERROR")).toBe("genericError");
  expect(apiErrorKey("constructor")).toBe("genericError");
});
