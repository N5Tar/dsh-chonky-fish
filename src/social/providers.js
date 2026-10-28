import { fail } from './core.js'

export const PROVIDERS = Object.freeze({
  napcat: Object.freeze({ id: 'napcat', platform: 'qq', protocol: 'onebot-v11', displayName: 'NapCatQQ', verified: false }),
  snowluma: Object.freeze({ id: 'snowluma', platform: 'qq', protocol: 'onebot-v11', displayName: 'SnowLuma', verified: false }),
  'onebots-discord': Object.freeze({ id: 'onebots-discord', platform: 'discord', protocol: 'onebot-v12', displayName: 'OneBots', verified: false }),
})
export function providerFor(config) {
  if (!Object.hasOwn(PROVIDERS, config.provider)) fail('SOCIAL_UNSUPPORTED_PROVIDER')
  const provider = PROVIDERS[config.provider]
  if (provider.platform !== config.platform) fail('SOCIAL_PLATFORM_MISMATCH')
  return provider
}
