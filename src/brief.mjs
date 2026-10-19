// Turning a movie title into a genre so the glossary can be picked without
// asking the user. Purely offline and deterministic: a set of keyword rules,
// first match wins. Anything unrecognised falls back to `general`, which has
// no terminology overrides at all.

const RULES = [
    { genre: 'sci-fi', re: /\b(star\s?(wars|trek)|space|galaxy|alien|prometheus|interstellar|gravity|the martian|moon|solaris|dune|avatar|matrix|terminator|blade runner|robocop|tron|predator|arrival|contact|event horizon|ex machina|annihilation|inception|tenet|2001|blade)\b/i },
    { genre: 'horror', re: /\b(zombie|zombies|undead|world war z|resident evil|28 (days|weeks) later|dawn of the dead|day of the dead|evil dead|the exorcist|exorcism|conjuring|insidious|sinister|halloween|scream|nightmare on elm|the ring|grudge|omen|poltergeist|hellraiser|it\b|purge|saw|train to busan|rec\b|let the right one in|cabin in the woods|quiet place|get out|hereditary|midsommar)\b/i },
    { genre: 'fantasy', re: /\b(lord of the rings|hobbit|harry potter|fantastic beasts|narnia|dragon|dungeons|witcher|game of thrones|house of the dragon|merlin|arthur|excalibur|willow|stardust|pan'?s labyrinth|labyrinth|neverending story|princess bride|chronicles)\b/i },
    { genre: 'crime', re: /\b(godfather|goodfellas|scarface|departed|pulp fiction|snatch|lock,? stock|ocean'?s|heat\b|sicario|narcos|breaking bad|better call saul|the town|baby driver|john wick|seven|se7en|zodiac|prisoners|gone girl|nightcrawler|heist|mafia|cartel)\b/i },
    { genre: 'war', re: /\b(saving private ryan|platoon|dunkirk|1917|fury\b|band of brothers|full metal jacket|black hawk down|hurt locker|hacksaw ridge|enemy at the gates|schindler|patton|apocalypse now|deer hunter|thin red line|inglourious)\b/i },
    { genre: 'romance', re: /\b(love\s?(actually|story)|the notebook|titanic|pride and prejudice|la la land|before (sunrise|sunset|midnight)|dirty dancing|ghost\b|sleepless in seattle|notting hill|four weddings|breakfast at tiffany|brokeback|call me by your name|normal people)\b/i },
];

/**
 * @param {string} title
 * @returns {string} one of the keys of GENRES
 */
export function inferGenre(title) {
    for (const rule of RULES) {
        if (rule.re.test(title)) return rule.genre;
    }
    return 'general';
}
