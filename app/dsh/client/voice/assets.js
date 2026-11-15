const getKey = (manifest, name) => {
  const entry = manifest?.files?.[name]
  if (!entry || typeof entry.file !== 'string' || typeof entry.key !== 'string' || !/^[a-z0-9-]+\.[a-z]+$/i.test(entry.key) || !/^[0-9a-f]{64}$/i.test(entry.sha256) || !entry.key.includes(entry.sha256)) {
    throw new TypeError(`Voice asset manifest entry is invalid: ${name}`)
  }
  return entry.key
}

/** Resolve only keys from the Host's SHA-validated build manifest. */
export function resolveVoiceAssets(endpoint, manifest, base = globalThis.location?.href) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/chonkyfish/voice/assets') || !manifest || manifest.version !== 1) throw new TypeError('Trusted voice asset endpoint and manifest are required')
  const url = key => {
    const result = new URL(endpoint, base)
    result.searchParams.set('key', key)
    return result.href
  }
  return Object.freeze({
    manifestUrl: url('manifest.json'),
    modelUrl: url(getKey(manifest, 'model')),
    ortModuleUrl: url(getKey(manifest, 'runtime')),
    wasmPaths: Object.freeze({ mjs: url(getKey(manifest, 'wasmModule')), wasm: url(getKey(manifest, 'wasmBinary')) }),
    workerUrl: url(getKey(manifest, 'vadWorker')),
    workletUrl: url(getKey(manifest, 'captureWorklet')),
  })
}
