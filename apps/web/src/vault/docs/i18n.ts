import { createI18n } from "../../i18n/create";
import { vaultDocsEn } from "./i18n/en";
import { vaultDocsEs } from "./i18n/es";
import { vaultDocsFr } from "./i18n/fr";
import { vaultDocsIt } from "./i18n/it";

/** The vault's documentation's messages. */
export const { t, useT } = createI18n({ en: vaultDocsEn, fr: vaultDocsFr, es: vaultDocsEs, it: vaultDocsIt });
