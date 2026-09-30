import { createI18n } from "./create";
import { en } from "./app/en";
import { es } from "./app/es";
import { fr } from "./app/fr";
import { it } from "./app/it";

export const APP_MESSAGES = { en, fr, es, it } as const;

/** The app's messages. `t` for plain functions, `useT` inside components. */
export const { t, useT, lookup } = createI18n(APP_MESSAGES);
export type { AppKey } from "./app/en";
