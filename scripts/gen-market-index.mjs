// Regenerates market-index.json (plugin market index format 1) from package.json.
// Run after bumping the version: node scripts/gen-market-index.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const index = {
  format: 1,
  title: { en: 'yoletPig community plugins', zh: 'yoletPig 社区插件' },
  description: {
    en: 'Community plugins for the DeepSeek Harness, published on npm',
    zh: '发布在 npm 上的 DeepSeek Harness 社区插件',
  },
  metadata: {},
  plugins: [{
    name: pkg.name,
    title: { en: 'RapidSpeech ASR (local)', zh: 'RapidSpeech 本地语音识别' },
    description: {
      en: 'Offline speech-to-text via a local RapidSpeech.cpp rs-server; recordings stay on this machine.',
      zh: '通过本地 RapidSpeech.cpp rs-server 离线转写录音，音频不出本机。',
    },
    author: 'yoletPig',
    homepage: 'https://github.com/yoletPig/dsh-plugin-rapidspeech',
    repository: { url: 'https://github.com/yoletPig/dsh-plugin-rapidspeech' },
    metadata: { keywords: ['asr', 'voice', 'rapidspeech', 'local', 'speech-to-text'] },
    versions: [{
      version: pkg.version,
      publishTimestamp: Math.floor(Date.now() / 1000),
      source: { type: 'npm' },
      engines: { dsh: pkg.engines.dsh },
    }],
  }],
}

writeFileSync('market-index.json', JSON.stringify(index, null, 2) + '\n')
console.log(`market-index.json written for ${pkg.name}@${pkg.version}`)
