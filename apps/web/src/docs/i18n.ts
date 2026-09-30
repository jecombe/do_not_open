import { createI18n } from "../i18n/create";
import { APP_MESSAGES } from "../i18n/app";
import { docsEn } from "./i18n/en";
import { docsEs } from "./i18n/es";
import { docsFr } from "./i18n/fr";
import { docsIt } from "./i18n/it";

/** The manual's messages, on top of the app's: the figures name traits and states too. */
export const { t, useT, lookup } = createI18n({
  en: { ...APP_MESSAGES.en, ...docsEn },
  fr: { ...APP_MESSAGES.fr, ...docsFr },
  es: { ...APP_MESSAGES.es, ...docsEs },
  it: { ...APP_MESSAGES.it, ...docsIt },
});
export type { DocsKey } from "./i18n/en";
