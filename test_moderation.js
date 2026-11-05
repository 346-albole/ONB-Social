import { checkModeration } from './src/lib/moderation.js'

async function test() {
  const profile = { id: 'test', warnings_count: 0 }
  
  // Mocking the forbidden words since it fetches from Supabase
  // For the sake of this test, I'll modify the moderation.js temporarily 
  // or just trust the regex logic I wrote.
  
  console.log("Testing regex construction...")
  const escapeRegExp = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const normalizedWord = "6&7"
  const regexPattern = normalizedWord.split('&').map(escapeRegExp).join('.*')
  const regex = new RegExp(regexPattern, 'i')
  
  const texts = ["67", "6 and 7", "6abc7", "hello world", "76", "6...7"]
  
  texts.forEach(t => {
    console.log(`Text: "${t}" -> Match: ${regex.test(t)}`)
  })
}

test()
