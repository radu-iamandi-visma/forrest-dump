// Shared Google Maps JS loader. Uses the official inline-bootstrap pattern so that
// `google.maps.importLibrary` is installed synchronously and the actual script is
// fetched async on the first importLibrary() call.

const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY

let mapsBootstrapPromise = null

function installImportLibraryBootstrap(apiKey) {
  if (window.google?.maps?.importLibrary) return

  const g = { key: apiKey, v: 'weekly' }
  const m = document
  const b = window.google || (window.google = {})
  const d = b.maps || (b.maps = {})
  const r = new Set()
  const e = new URLSearchParams()
  const q = '__ib__'
  let h

  const u = () =>
    h ||
    (h = new Promise((resolve, reject) => {
      const a = m.createElement('script')
      e.set('libraries', [...r].join(','))
      for (const k in g) e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k])
      e.set('callback', 'google.maps.' + q)
      a.src = 'https://maps.googleapis.com/maps/api/js?' + e
      a.async = true
      a.defer = true
      d[q] = resolve
      a.onerror = () => {
        h = null
        reject(new Error('Google Maps could not load.'))
      }
      m.head.append(a)
    }))

  d.importLibrary = (f, ...n) => (r.add(f), u().then(() => d.importLibrary(f, ...n)))
}

export function loadGoogleMapsLibraries() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (!MAPS_API_KEY) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'))
  if (mapsBootstrapPromise) return mapsBootstrapPromise

  installImportLibraryBootstrap(MAPS_API_KEY)

  mapsBootstrapPromise = Promise.all([
    window.google.maps.importLibrary('core'),
    window.google.maps.importLibrary('maps'),
    window.google.maps.importLibrary('drawing'),
    window.google.maps.importLibrary('geometry'),
  ])
    .then(([core, maps, drawing, geometry]) => ({
      google: window.google,
      core,
      maps,
      drawing,
      geometry,
    }))
    .catch((err) => {
      mapsBootstrapPromise = null
      throw err
    })

  return mapsBootstrapPromise
}
