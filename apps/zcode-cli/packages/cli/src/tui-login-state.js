import { getZCodeCopy } from "@zcode/i18n";
export function loginRequiredResponse(locale) {
    const copy = getZCodeCopy(locale).tui.loginRequired;
    return [copy.message, copy.help].join("\n");
}
/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(getApp) {
    return async () => {
        const app = await getApp();
        return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
    };
}
