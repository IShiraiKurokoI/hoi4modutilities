import { getConfiguration } from "./vsccommon";

const featureFlags = getConfiguration().featureFlags;

export const useConditionInFocus = !featureFlags.includes('!useConditionInFocus');
export const eventTreePreview = featureFlags.includes('eventTreePreview');
