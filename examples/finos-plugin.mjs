// Example: drop the anti-attribution engine into a FINOS git-proxy push chain.
//
// FINOS git-proxy loads plugins that export PushActionPlugin instances. This
// module exports one that runs the antint scan and blocks the push (sets
// action.error / action.errorMessage) when attribution signals are found.
//
// In your FINOS proxy.config.json:
//   { "plugins": ["./examples/finos-plugin.mjs"] }
//
// Requires both @finos/git-proxy and git-antint-proxy to be installed.

import { createAntintPushPlugin } from 'git-antint-proxy/plugin';

// Optionally pass a config object; otherwise antint.config.json is read from the
// cloned repo working tree that FINOS prepares for the chain.
export default await createAntintPushPlugin();
