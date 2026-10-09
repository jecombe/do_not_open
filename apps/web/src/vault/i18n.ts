import { createI18n } from "../i18n/create";
import { vaultEn } from "./i18n/en";
import { vaultEs } from "./i18n/es";
import { vaultFr } from "./i18n/fr";
import { vaultIt } from "./i18n/it";

/** The vault page's messages. */
export const { t, useT } = createI18n({ en: vaultEn, fr: vaultFr, es: vaultEs, it: vaultIt });
