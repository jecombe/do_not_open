import { createI18n } from "../../i18n/create";
import { vaultTxEn } from "./i18n/en";
import { vaultTxEs } from "./i18n/es";
import { vaultTxFr } from "./i18n/fr";
import { vaultTxIt } from "./i18n/it";

/** The vault's transaction stage and dock: small on purpose, the home page and the docs load it too. */
export const { t, useT } = createI18n({ en: vaultTxEn, fr: vaultTxFr, es: vaultTxEs, it: vaultTxIt });
