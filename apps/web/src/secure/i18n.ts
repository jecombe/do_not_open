import { createI18n } from "../i18n/create";
import { secureEn } from "./i18n/en";
import { secureEs } from "./i18n/es";
import { secureFr } from "./i18n/fr";
import { secureIt } from "./i18n/it";

/** The secure home page's own messages. */
export const { t, useT } = createI18n({
  en: secureEn,
  fr: secureFr,
  es: secureEs,
  it: secureIt,
});
