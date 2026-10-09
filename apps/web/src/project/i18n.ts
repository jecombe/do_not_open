import { createI18n } from "../i18n/create";
import { projectEn } from "./i18n/en";
import { projectEs } from "./i18n/es";
import { projectFr } from "./i18n/fr";
import { projectIt } from "./i18n/it";

/** The project's documentation's messages. */
export const { t, useT } = createI18n({ en: projectEn, fr: projectFr, es: projectEs, it: projectIt });
