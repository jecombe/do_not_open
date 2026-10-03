import { createI18n } from "../i18n/create";
import { homeEn } from "./i18n/en";
import { homeEs } from "./i18n/es";
import { homeFr } from "./i18n/fr";
import { homeIt } from "./i18n/it";

/** The home page's messages. The cat parade brings the manual's along with it. */
export const { t, useT } = createI18n({ en: homeEn, fr: homeFr, es: homeEs, it: homeIt });
