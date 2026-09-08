import type { AccessProfile } from './build-access-profile.js';

export const applyFeatureFlags = (
  profile: AccessProfile,
  features: ReadonlyArray<{
    readonly enabled: boolean;
    readonly resourceTypes: ReadonlyArray<string>;
  }>,
): AccessProfile => {
  const disabledResources = new Set(
    features
      .filter((feature) => !feature.enabled)
      .flatMap((feature) => feature.resourceTypes),
  );
  if (disabledResources.size === 0) {
    return profile;
  }
  return {
    permissions: profile.permissions,
    capabilities: profile.capabilities.filter(
      (capability) => !disabledResources.has(capability.resource),
    ),
    navigation: profile.navigation.filter(
      (item) => !disabledResources.has(item.resource),
    ),
  };
};
