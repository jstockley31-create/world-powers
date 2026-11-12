// World Powers — game rules. The SERVER runs every change; browsers only use this file to display numbers.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.WPCore = factory(); })(this, function () {
'use strict';
const MIN = 60e3, HOUR = 36e5, TICK = 10 * MIN, TICKS_PER_YEAR = 144; // one game year = one real day
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const RES = { food: { n: 'Food', p: 50 }, oil: { n: 'Oil', p: 120 }, steel: { n: 'Steel', p: 100 }, goods: { n: 'Goods', p: 200 }, mun: { n: 'Munitions', p: 760 } };
const rName = r => r === 'mun' ? 'munitions' : r;
// MUNITIONS: made on the Military page from steel and oil, stored up ahead of time, and spent by missile strikes, special attacks and dirty bombs.
// Each order is limited by the factories' hourly output, and the depots only hold so much; the world market only sells up to the free depot space.
const MUN = { steel: 2, oil: 1, cash: 300, start: 300, batch: n => 200 + 10 * Math.floor((n && n.tech) || 0), cap: n => 1000 + 40 * Math.floor((n && n.tech) || 0) };
const TYPE = {
  F: { n: 'Farmland', p: { food: 30 } }, O: { n: 'Oil fields', p: { oil: 15, food: 5 } }, M: { n: 'Mining region', p: { steel: 15, food: 5 } },
  I: { n: 'Industrial region', p: { goods: 12, food: 5 } }, P: { n: 'Plains', p: { food: 15 }, cash: 1 }, D: { n: 'Desert', p: { food: 4 }, cash: 1 }
};
const CAPP = { food: 25, goods: 10, oil: 5, steel: 5 };
const RANKS = [[0, 'Chieftain'], [100, 'Elder'], [300, 'Mayor'], [700, 'Governor'], [1500, 'Senator'], [3000, 'Prime Minister'], [6000, 'President'], [12000, 'Sovereign'], [25000, 'Emperor'], [50000, 'Supreme Leader'], [100000, 'World Power']];
const GOV = {
  dem: { n: 'Democracy', ap: 6, st: 0, inc: 1.05, mil: 1, res: 1.15, d: '+5% tax revenue and faster research. Approval bonus. Elections every 3 days. Wars cost twice the approval.' },
  mon: { n: 'Monarchy', ap: 0, st: 12, inc: 1, mil: 1.05, res: 1, d: 'Highly stable. Small military bonus. No elections.' },
  dic: { n: 'Dictatorship', ap: -8, st: 6, inc: .95, mil: 1.15, res: .9, d: '+15% military strength; war barely dents approval. Lower approval and income. No elections.' },
  com: { n: 'Communist State', ap: -3, st: 6, inc: 1, mil: 1.05, res: 1, cheap: .75, d: 'Recruiting and construction cost 25% less. Lower approval. No elections.' }
};
// map colours only past season champions may use
const CHAMP_COLORS = ['#ffc93c', '#e3ebf5'], CHAMP_COLOR_NAMES = { '#ffc93c': 'Champion gold', '#e3ebf5': 'Platinum' };
const isChampion = n => !!n && ((n.badges || []).some(b => b.k === 'champion') || (n.titles || []).some(t => t.r === 1));
const COLORS = ['#c8553d', '#3f88c5', '#44af69', '#d4a64a', '#8e6fd8', '#e07a9c', '#2ab7a9', '#e88d3f', '#6c8ead', '#b5c44a', '#a23b72', '#5b6ee1', '#d65f5f', '#4f9d8f', '#c69c6d', '#7fb3d5'];
const ACTS = [
  { k: 'tax', s: 'Taxes', n: 'Collect Taxes', i: 'coins', cd: 3, xp: 5 },
  { k: 'prod', s: 'Production', n: 'Boost Production', i: 'factory', cd: 5, xp: 6 },
  { k: 'recruit', s: 'Army', n: 'Recruit Troops', i: 'recruit', cd: 4, xp: 5 },
  { k: 'navy', s: 'Navy', n: 'Build Warships', i: 'ship', cd: 8, xp: 8 },
  { k: 'air', s: 'Air Force', n: 'Build Aircraft', i: 'plane', cd: 8, xp: 8 },
  { k: 'expand', s: 'Expand', n: 'Expand Borders', i: 'expand', cd: 10, xp: 20 },
  { k: 'research', s: 'Research', n: 'Fund Research', i: 'flask', cd: 15, xp: 15 },
  { k: 'drill', s: 'Exercises', n: 'Military Exercises', i: 'target', cd: 8, xp: 8 },
  { k: 'infra', s: 'Infrastructure', n: 'Build Infrastructure', i: 'build', cd: 20, xp: 15 },
  { k: 'fort', s: 'Fortify', n: 'Fortify Borders', i: 'fort', cd: 30, xp: 15 },
  { k: 'spies', s: 'Spies', n: 'Train Agents', i: 'eye', cd: 15, xp: 8 },
  { k: 'rally', s: 'Address', n: 'Address the Nation', i: 'mega', cd: 15, xp: 5 },
  { k: 'campaign', s: 'Campaign', n: 'Election Campaign', i: 'vote', cd: 30, xp: 5, dem: true },
  { k: 'daily', s: 'Aid', n: 'International Aid', i: 'gift', cd: 1440, xp: 50 }
];
const DEFCFG = { cd: 1, income: 1, xp: 1, protectH: 48, war: true, signups: true, motd: '', bots: 12, botWar: 'yes', botRetire: true, electionH: 72, eventsOn: true, conquest: true, lastStandH: 24, weakRule: false, councilAuto: false, nukeTest: false, aiBoss: true, donateUrl: 'https://paypal.me/striphesstockgame' };
// Chain events: a crisis that unfolds over several decisions. An option's third element names the next step.
const CHAINS = {
  strike1: { t: 'General strike', d: 'The national federation of unions has called a general strike over wages and rising prices. Ports and factories are shutting down.', o: [['Open wage negotiations', { tr: -1, ap: 3 }, 'strike2a'], ['Declare the strike illegal', { st: -4, ap: -6 }, 'strike2b'], ['Wait it out', { gdp: -1, ap: -2 }, 'strike2c']] },
  strike2a: { t: 'Union raises its demands', d: 'Talks are going well, but union leaders now also want a pension guarantee before anyone returns to work.', o: [['Agree to the pension guarantee', { tr: -2, ap: 5, st: 3 }], ['Hold firm on wages only', { ap: -2 }, 'strike3'], ['Ask an independent mediator', { tr: -.5, st: 2, ap: 2 }]] },
  strike2b: { t: 'Clashes at the ports', d: 'Police and strikers clashed overnight at the main port. Footage of the violence is everywhere.', o: [['Deploy the army to restore order', { st: 3, ap: -8, troops: -40 }], ['Withdraw police and reopen talks', { ap: 2, st: -3 }, 'strike2a'], ['Arrest the strike leaders', { st: -6, ap: -5, aggr: 3 }, 'strike3']] },
  strike2c: { t: 'The strike drags on', d: 'Three weeks in, shelves are emptying and exporters are losing contracts abroad.', o: [['Make a generous offer', { tr: -2.5, ap: 4, st: 4 }], ['Bring in replacement workers', { gdp: 1, ap: -6, st: -4 }, 'strike3'], ['Keep waiting', { gdp: -2, food: -150, ap: -3 }]] },
  strike3: { t: 'Nationwide shutdown', d: 'Other sectors have joined in solidarity. The country has nearly ground to a halt.', o: [['Concede to every demand', { tr: -3, ap: 6, st: 5, infl: 1 }], ['Call early elections', { ap: 3, st: -5 }], ['Impose a state of emergency', { st: -8, ap: -10, aggr: 5 }]] },
  scandal1: { t: 'Corruption allegations', d: 'Investigative journalists allege that your finance minister accepted bribes from a construction company.', o: [['Dismiss the minister immediately', { st: -2, ap: 2 }], ['Defend the minister publicly', { ap: -4 }, 'scandal2a'], ['Order an independent inquiry', { tr: -.5 }, 'scandal2b']] },
  scandal2a: { t: 'More evidence emerges', d: 'Leaked bank records appear to show payments to the minister — and to two of your other officials.', o: [['Fire all three', { st: -4, ap: 3 }], ['Call the leaks a smear campaign', { ap: -7, st: -3 }, 'scandal3'], ['Resign the finance portfolio yourself', { ap: 1, st: -2 }]] },
  scandal2b: { t: 'Inquiry report', d: 'The inquiry finds the minister guilty, but clears the rest of the government. Opposition parties say it was a whitewash.', o: [['Publish the full report', { ap: 4, st: 2 }], ['Publish a summary only', { ap: -2 }], ['Pass anti-corruption laws', { tr: -1, ap: 5, gdp: .5 }]] },
  scandal3: { t: 'Mass protests', d: 'Tens of thousands march against corruption in the capital, demanding your resignation.', o: [['Reshuffle the whole cabinet', { st: -3, ap: 4 }], ['Disperse the protests', { st: -6, ap: -8, aggr: 4 }], ['Promise a referendum on reform', { ap: 6, st: -2 }]] },
  chip1: { t: 'Microchip breakthrough', d: 'A domestic startup has designed a chip far ahead of anything else on the market. It needs money to scale up.', o: [['Fund a national chip program', { tr: -2 }, 'chip2a'], ['Let private investors handle it', { gdp: .5 }, 'chip2b'], ['Sell the design abroad', { tr: 3, tech: -1 }]] },
  chip2a: { t: 'The first factory', d: 'The state-backed factory is ready, but it needs rare materials and skilled engineers.', o: [['Import engineers and materials', { tr: -1.5, steel: -60 }, 'chip3'], ['Train local engineers instead', { edu: 4, tr: -1 }, 'chip3'], ['Scale back the program', { tr: 1, ap: -2 }]] },
  chip2b: { t: 'Foreign takeover bid', d: 'A foreign conglomerate offers to buy the startup outright, with a huge payout to its founders.', o: [['Allow the sale', { tr: 1.5, gdp: -.5 }], ['Block it on security grounds', { st: 2, aggr: 2 }, 'chip3'], ['Take a government stake', { tr: -1 }, 'chip3']] },
  chip3: { t: 'Chips go global', d: 'The chips are a hit. Orders pour in from around the world.', o: [['Invest profits in research', { tech: 1, edu: 3 }], ['Cut taxes with the windfall', { ap: 5, tr: 1 }], ['Build export capacity', { gdp: 2, goods: 120, unemp: -1 }]] },
  drought1: { t: 'Severe drought', d: 'The rainy season has failed. Farmers warn of a poor harvest and reservoirs are falling fast.', o: [['Buy emergency food imports', { tr: -1.5, food: 250 }, 'drought2a'], ['Ration water nationwide', { ap: -4, food: 80 }, 'drought2b'], ['Do nothing and hope for rain', { food: -150 }, 'drought2c']] },
  drought2a: { t: 'Import prices soar', d: 'Other nations are buying too. Grain prices on world markets have doubled.', o: [['Keep buying', { tr: -2, food: 200, ap: 2 }], ['Build desalination plants', { tr: -2.5, infra: 1, health: 2 }], ['Subsidise drought-resistant crops', { tr: -1, gdp: .5 }]] },
  drought2b: { t: 'Farmers protest', d: 'Farmers block highways with tractors, saying rationing is ruining them.', o: [['Compensate farmers', { tr: -1.5, ap: 4 }], ['Exempt agriculture from rationing', { food: 120, ap: -2, health: -2 }], ['Clear the roads', { st: -4, ap: -5 }]] },
  drought2c: { t: 'Famine warnings', d: 'Aid agencies warn of famine in rural regions. Food prices are climbing quickly.', o: [['Emergency aid program', { tr: -3, food: 300, ap: 3 }], ['Ask the world for help', { food: 200, st: -2 }], ['Blame the previous government', { ap: -6, st: -4, pop: -1 }]] },
  refugee1: { t: 'Refugees at the border', d: 'A civil war abroad has sent tens of thousands of refugees to your border, asking for shelter.', o: [['Open the border', { pop: 2, ap: -3, tr: -1 }, 'refugee2a'], ['Build camps at the border', { tr: -1.5, st: 1 }, 'refugee2b'], ['Close the border', { ap: 2, aggr: 3 }]] },
  refugee2a: { t: 'Integration challenges', d: 'Newcomers need housing, jobs and language classes. Some towns are struggling.', o: [['Fund an integration program', { tr: -1.5, unemp: -1, ap: 3 }], ['Fast-track work permits', { gdp: 1, unemp: 1, ap: -2 }], ['Leave it to local towns', { st: -3, ap: -2 }]] },
  refugee2b: { t: 'Camp conditions', d: 'Reports describe overcrowding and disease in the border camps. Aid groups are calling for action.', o: [['Improve the camps', { tr: -1.5, health: 2, ap: 2 }], ['Resettle refugees across the country', { pop: 1.5, ap: -3 }, 'refugee2a'], ['Restrict press access', { st: -2, ap: -5 }]] }
};
const CHAIN_STARTS = ['strike1', 'scandal1', 'chip1', 'drought1', 'refugee1'];
// Generals: earned in victory, lost in defeat
const GEN_FIRST = ['Alexei', 'Maren', 'Tomas', 'Ilse', 'Rafael', 'Noor', 'Kenji', 'Elena', 'Viktor', 'Amara', 'Dario', 'Sven', 'Lucia', 'Omar', 'Hana', 'Felix', 'Ines', 'Bram', 'Yara', 'Casimir', 'Petra', 'Malik', 'Astrid', 'Jonah'];
const GEN_LAST = ['Varga', 'Holm', 'Okafor', 'Brandt', 'Castell', 'Rourke', 'Sato', 'Lindqvist', 'Marek', 'Duarte', 'Haddad', 'Novak', 'Ferreira', 'Kowal', 'Abara', 'Strand', 'Morel', 'Tanaka', 'Ilic', 'Rayne', 'Vasquez', 'Achterberg'];
const GEN_TYPES = { attack: { n: 'Field marshal', d: '+4% attack strength per star' }, defense: { n: 'Defense commander', d: '+4% defense in every province per star' }, logistics: { n: 'Quartermaster general', d: 'Distant attacks: 10% smaller penalty and cost per star' } };
const LAWS = {
  conscription: { n: 'Conscription', d: 'Every citizen serves: recruit 50% more soldiers per batch and your troop limit rises from 4% to 6% of the population. Approval drifts 5 lower.', ap: -5 },
  healthcare: { n: 'Universal healthcare', d: 'Health drifts 15 higher (faster population growth) and approval +3. Government spending costs 15% more.', ap: 3, health: 15, spend: 1.15 },
  education: { n: 'Free education', d: 'Education drifts 15 higher and research costs 15% less. Government spending costs 10% more.', edu: 15, research: .85, spend: 1.1 },
  censorship: { n: 'Press censorship', d: 'Stability drifts 8 higher. Approval drifts 4 lower, and enemy spies succeed more often against you.', st: 8, ap: -4 },
  greenEnergy: { n: 'Green energy', d: 'Oil consumption falls 40% and approval +2. GDP is 3% lower.', oil: .6, ap: 2, gdp: .97 },
  freeMarket: { n: 'Free market', d: 'Imports 3% cheaper, exports earn 3% more, GDP +3%. Unemployment drifts 1.5 points higher.', spread: .03, gdp: 1.03, unemp: 1.5 },
  martialLaw: { n: 'Martial law', d: 'Stability drifts 12 higher and your provinces defend 10% better. Approval drifts 10 lower and GDP is 4% lower.', st: 12, def: 1.1, ap: -10, gdp: .96 },
  businessTax: { n: 'Business tax cuts', d: 'Unemployment drifts 1.5 points lower and GDP +2%. Tax revenue is 10% lower.', unemp: -1.5, gdp: 1.02, tax: .9 }
};
const WONDERS = {
  exchange: { n: 'Global Stock Exchange', d: '+10% tax revenue and +3% GDP.', stages: 4, cost: { cash: 4e6, steel: 400, goods: 500 }, fx: { tax: 1.1, gdp: 1.03 } },
  space: { n: 'Space Program', d: 'Research costs 25% less and operations earn 20% more XP.', stages: 5, cost: { cash: 6e6, steel: 600, goods: 600, oil: 400 }, fx: { research: .75, xp: 1.2 } },
  wall: { n: 'Great Wall', d: 'Every province you hold defends 15% better.', stages: 4, cost: { cash: 3.5e6, steel: 1000 }, fx: { def: 1.15 } },
  olympics: { n: 'Olympic Games', d: '+6 approval and +4 stability for good, and +2% GDP from tourism.', stages: 3, cost: { cash: 3e6, goods: 600, food: 800 }, fx: { ap: 6, st: 4, gdp: 1.02 } },
  port: { n: 'Grand Global Port', d: 'Market fees cut in half for you, and trade bonuses count up to 7 partners instead of 5.', stages: 4, cost: { cash: 3.5e6, steel: 500, oil: 400 }, fx: { spread: .04, tcap: 2 } }
};
// alliances: teams of nations with a shared treasury, a flag, joint projects and daily team goals
const BLOC = { cost: 10e6, rank: 2, max: 6, hqMax: 8, stageH: 3, wall: 120, nameMin: 3, nameMax: 28, inviteH: 72, goalOps: 25, goalDec: 3 };
const BPROJ = {
  market: { n: 'Common Market', d: '+6% tax revenue for every member.', stages: 3, fx: { tax: 1.06 } },
  defense: { n: 'Mutual Defense Network', d: 'Every member\'s provinces defend 8% better.', stages: 3, fx: { def: 1.08 } },
  research: { n: 'Joint Research Institute', d: 'Research costs 12% less for every member.', stages: 3, fx: { research: .88 } },
  devbank: { n: 'Development Bank', d: '+3% GDP for every member.', stages: 4, fx: { gdp: 1.03 } },
  college: { n: 'War College', d: 'Operations earn 15% more XP for every member.', stages: 3, fx: { xp: 1.15 } },
  hq: { n: 'Alliance Headquarters', d: '+3 approval and +3 stability for every member, and room for 2 more members (8 instead of 6).', stages: 4, fx: { ap: 3, st: 3 } }
};
// world crises: a threat to everyone. Each nation chooses to cooperate (pay into a shared world effort) or exploit (take an instant profit).
// If the world effort is met in time, the threat is averted and the top contributors are rewarded; if not, disaster strikes.
const CRISIS = { diff: { easy: .015, normal: .03, hard: .05 }, minGoal: 2e8, botShare: .45, minGive: 1e5, exploitGdp: .03, exploitAggr: 10 };
const CRISES = {
  pandemic: { n: 'Pandemic Z', ic: '🦠', d: 'A deadly new virus is spreading across every continent. A joint vaccine program can stop it — if the world funds it in time.',
    coop: 'Fund the vaccine program', coopD: 'Pay into the global vaccine fund. If it is fully funded in time, the pandemic is stopped and every contributor is rewarded.',
    exploit: 'Hoard medicine and profit', exploitD: 'Sell scarce medicine at sky-high prices: an instant windfall worth 3% of your GDP, +10 aggression, and the world will remember. If the program fails, your stockpiles protect you from half the losses.',
    win: 'The vaccine program succeeded and the pandemic is over.', lose: 'The vaccine fund fell short. The pandemic swept the world: every nation lost 4% of its population, and GDP is 8% lower for 24 hours.', during: { gdp: .97 } },
  asteroid: { n: 'Asteroid Kessler-7', ic: '☄️', d: 'Astronomers have spotted a city-killer asteroid on a collision course with Earth. Only a joint deflection mission can push it off course.',
    coop: 'Fund the deflection mission', coopD: 'Pay for rockets and engineers. If the mission is fully funded in time, the asteroid is deflected and every contributor is rewarded.',
    exploit: 'Sell doomsday bunkers', exploitD: 'Sell bunkers to the panicking public: an instant windfall worth 3% of your GDP and +10 aggression. If the asteroid hits, your bunkers spare you the impact winter.',
    win: 'The deflection mission worked. Kessler-7 sailed harmlessly past Earth.', lose: 'The mission was never funded. Kessler-7 struck the Earth: the impact zone is devastated and an impact winter cuts GDP 10% for 24 hours for everyone without bunkers.' },
  aliens: { n: 'First Contact', ic: '🛸', d: 'A signal from deep space has been decoded: an alien probe is offering knowledge to a united humanity. It will only share with a world that works together.',
    coop: 'Join the welcome mission', coopD: 'Pay into a joint mission to meet the probe. If it is fully funded in time, every contributor gains a tech level (top contributors gain two).',
    exploit: 'Try to seize the probe alone', exploitD: 'Send a secret team to grab the technology for yourself: a 40% chance of +2 tech levels, otherwise the attempt fails and costs you 2% of your treasury. +10 aggression either way.',
    win: 'The world united and the probe shared its knowledge. Contributors leap ahead in technology.', lose: 'The world could not agree. The probe went silent and left the solar system.' },
  boss: { n: 'The Rising Power', ic: '⚠', d: 'A Rising Power, armed by foreign backers, threatens to overrun the world. Only a coalition of nations can bring it down before the deadline.',
    coop: 'Join the coalition', coopD: 'Fight it or fund the coalition: every battle against the Rising Power and every dollar you pay in counts toward your contribution. If it falls in time, the top contributors are rewarded.',
    exploit: 'Sell arms to the Rising Power', exploitD: 'Profit from the war: an instant windfall worth 3% of your GDP and +10 aggression, but the Rising Power gains 3% more troops from your weapons.',
    win: 'The coalition brought down the Rising Power.', lose: 'The deadline passed and the Rising Power still stands, emboldened.' }
};
// province development: each province can be built up from empty land to a metropolis
const DEV = { names: ['Undeveloped', 'Farms', 'Industry', 'City', 'Metropolis'], max: 4, mult: [1, 2.5, 6, 14], steel: [0, 100, 300, 800], goods: [0, 50, 200, 600], base: 4e6, gdpPct: .004, cdMin: 15, prod: .3, score: 40, pop: 4e4, gdp: .015 };
// the World Games: every few days nations invest in three contests; the best get medals and prestige
const GAMES = { cats: { sport: { n: 'Athletics', ic: '🏅', d: 'Healthier nations get more out of every dollar.' }, science: { n: 'Science Expo', ic: '🔬', d: 'Every tech level makes your money go further.' }, culture: { n: 'Culture Festival', ic: '🎭', d: 'Better-educated nations shine brighter.' } },
  prestige: [5, 3, 1], ap: [6, 4, 2], xp: [150, 100, 60], minGive: 1e5, botShare: .4 };
// natural disasters hit real provinces; other nations can send relief and earn prestige
const DISASTER = { quake: { n: 'Earthquake', ic: '🌋' }, storm: { n: 'Hurricane', ic: '🌀' }, fire: { n: 'Wildfire', ic: '🔥' }, flood: { n: 'Flood', ic: '🌊' }, h: 12, pop: .04, st: 5, needPct: .02, needMin: 5e6, minGive: 1e5 };
// neglect: unstable empires risk outlying provinces declaring independence and becoming small AI nations
const REBEL = { st: 35, minProv: 5, p: .0012, spyP: .004, maxNations: 6 };
// moving the capital: a huge national undertaking (new ministries, relocating the Golden Dome, moving the government). Once every 72 hours at most.
const CAPMOVE = { gdpPct: .125, min: 6e7, steel: 1500, goods: 1000, oil: 750, domeX: 0, st: 25, ap: 12, morale: 15, cdH: 72, fortH: 12, holdH: 24, rank: 2, weakH: 24, weak: { tax: .8, def: .85, gdp: .95 } };
// nuclear accidents: any nation with a nuclear program risks a Chernobyl. Rare, random, and nothing can prevent it.
const NUKEACC = { perDay: 1 / 25, warheadX: 1.5, gapD: 7, h: 48, pop: .05, food: .4, steel: .2, goods: .2, oil: .1, cashPct: .02, st: 10, ap: 8, health: 10, crops: .7 };
// giving up nuclear weapons: the world (and your own people) celebrate. No new program for 7 days afterwards.
const DISARM = { ap: 12, st: 6, aggr: 20, warheadAp: 6, boost: { ap: 6, st: 4, h: 48 }, worldAp: 2, xp: 100, refund: .2, banD: 7 };
const EXPEDS = {
  mountains: { n: 'Mountain survey', d: 'Steel deposits and rare minerals — or an avalanche.', h: 3, cost: { cash: 2.5e5, food: 120, oil: 60 }, res: 'steel' },
  desert: { n: 'Desert prospecting', d: 'Oil fields under the sand — or a sandstorm.', h: 3, cost: { cash: 2.5e5, food: 150, oil: 40 }, res: 'oil' },
  jungle: { n: 'Jungle expedition', d: 'Lost cities, artifacts and exotic goods — and real dangers.', h: 5, cost: { cash: 4e5, food: 250, oil: 80 }, res: 'goods' },
  ocean: { n: 'Deep-sea expedition', d: 'Sunken treasure. Needs a coastal province.', h: 6, cost: { cash: 6e5, food: 150, oil: 200 }, res: 'cash', coast: true },
  arctic: { n: 'Arctic research station', d: 'A real chance of a scientific breakthrough (+1 tech level).', h: 8, cost: { cash: 8e5, food: 300, oil: 250 }, res: 'tech' }
};
const MISSIONS = {
  tax: { n: 'Collect taxes 8 times', goal: 8 }, prod: { n: 'Boost production 5 times', goal: 5 }, ops: { n: 'Run 15 operations', goal: 15 },
  research: { n: 'Fund research once', goal: 1 }, expand: { n: 'Expand your borders once', goal: 1 }, decide: { n: 'Make 2 decisions', goal: 2 },
  export: { n: 'Export 1,500 units on the market', goal: 1500 }, import: { n: 'Import 1,000 units on the market', goal: 1000 },
  win: { n: 'Win a battle', goal: 1, war: true }, approval: { n: 'Reach 70% approval', goal: 1, state: true }, stability: { n: 'Reach 65% stability', goal: 1, state: true },
  aid: { n: 'Send aid to another nation', goal: 1 }, recruit: { n: 'Recruit troops 3 times', goal: 3 }, infra: { n: 'Build infrastructure once', goal: 1 }, exped: { n: 'Send an expedition', goal: 1 }
};
const ACH = {
  firstWin: ['First Victory', 'Win your first battle'], conqueror: ['Conqueror', 'Capture an enemy capital'], prov10: ['Ten Provinces', 'Hold 10 provinces'], prov25: ['Empire', 'Hold 25 provinces'],
  tech10: ['Scholar', 'Reach tech level 10'], tech20: ['Visionary', 'Reach tech level 20'], gdp1b: ['Billion-Dollar Economy', 'GDP of $1 billion'], gdp10b: ['Economic Superpower', 'GDP of $10 billion'],
  rich: ['Fort Knox', '$100 million in the treasury'], streak7: ['Loyal Leader', 'A 7-day login streak'], diplomat: ['Diplomat', '3 allies at once'], trader: ['Merchant Prince', '50 market trades'],
  wonder: ['Wonder of the World', 'Complete a megaproject'], nuclear: ['Nuclear Power', 'Build a nuclear deterrent'], survivor: ['Survivor', 'Lead your nation for 30 days'],
  general: ['Legendary General', 'Have a 5-star general'], senator: ['Senator', 'Reach the rank of Senator'], president: ['President', 'Reach the rank of President'],
  explorer: ['Explorer', 'Complete 5 expeditions'], peacemaker: ['Peacemaker', 'Decommission your nuclear weapons'], hero: ['World Hero', 'Be a top-3 contributor when the world beats a crisis'], lawmaker: ['Lawmaker', 'Have 3 laws in force at once'], missions: ['Dedicated', 'Complete 30 daily missions'], dealmaker: ['Dealmaker', 'Complete 5 direct trades with other nations']
};
// achievement rewards: every achievement pays XP and cash (more for harder ones)
const ACH_TIER = { firstWin: 1, streak7: 1, trader: 1, lawmaker: 1, dealmaker: 1, prov10: 1, tech10: 1, diplomat: 2, rich: 2, gdp1b: 2, explorer: 2, missions: 2, nuclear: 2, senator: 2, peacemaker: 2, survivor: 2, conqueror: 3, prov25: 3, tech20: 3, gdp10b: 3, wonder: 3, general: 3, president: 3, hero: 3 };
const ACH_XP = [100, 250, 600], RANK_TAX = .03; // each rank also adds 3% to tax revenue
// a promotion pays out once: cash that grows with the rank (Mayor $6M ... World Power $150M), plus approval and stability
const promoCash = r => Math.round(1.5e6 * r * r);
const FLAG_LAYOUTS = ['solid', 'h2', 'h3', 'h3w', 'v2', 'v3', 'stripes', 'vstripes', 'cross', 'nordic', 'nordic1', 'saltire', 'union', 'diag', 'diag2', 'bend', 'tri', 'tri3', 'chevron', 'pall', 'hoistband', 'canton', 'starsstripes', 'border', 'frame', 'quad', 'quadcross', 'xquad', 'circle', 'lozenge', 'rays', 'checker', 'wavy', 'mountain'];
const FLAG_EMBLEMS = ['none', 'star', 'star6', 'star8', 'stars', 'starring', 'sun', 'moon', 'moonstar', 'circle', 'ring', 'shield', 'cross', 'triangle', 'diamond', 'crown', 'laurel', 'anchor', 'gear', 'tree', 'peak', 'waves', 'bolt', 'leaf', 'tower', 'swords', 'eagle', 'atom', 'flame', 'heart'];
const FLAG_COLORS = ['#c8102e', '#e8551e', '#f2c230', '#1e8f4e', '#0b6e4f', '#1f4fa8', '#0a2b6e', '#5fb6e8', '#6b2fa3', '#111111', '#ffffff', '#7a4a1f', '#d4a64a', '#e07a9c',
  '#8b0000', '#ff7f00', '#ffd700', '#7cc242', '#00a86b', '#00838f', '#1565c0', '#3949ab', '#002147', '#4a148c', '#9c27b0', '#c2185b', '#f48fb1', '#795548', '#9e9e9e', '#37474f', '#f5f0e1', '#b8860b'];
const FLAG_HEX = /^#[0-9a-fA-F]{6}$/;
const FLAG_HOIST = ['tri', 'tri3', 'chevron', 'pall', 'hoistband'], FLAG_CANTON = ['canton', 'starsstripes'];
// a flag as an SVG string (used in the game, on public nation pages and on the server). Older flags ({ l, c: [3 colours], e }) draw exactly as before.
function flagSVG(f, w, h, ns) {
  w = w || 30; h = h || 20; f = f || {}; const c = (Array.isArray(f.c) ? f.c : []).slice(0, 4).map(x => FLAG_HEX.test(x) ? x : '#888'); while (c.length < 4) c.push(c.length === 3 ? c[0] : (c[c.length - 1] || '#888'));
  const [a, b, d, q] = c, R = (x, y, ww, hh, col) => `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" fill="${col}"/>`, Pth = (p, col) => `<path d="${p}" fill="${col}"/>`;
  const sn = Math.max(3, Math.min(15, Math.round(f.sn || (f.l === 'starsstripes' ? 13 : 7)))); let g = '';
  switch (f.l) {
    case 'h2': g = R(0, 0, 30, 10, a) + R(0, 10, 30, 10, b); break;
    case 'h3': g = R(0, 0, 30, 7, a) + R(0, 6.67, 30, 6.67, b) + R(0, 13.33, 30, 6.67, d); break;
    case 'h3w': g = R(0, 0, 30, 20, a) + R(0, 5, 30, 10, b); break;
    case 'v2': g = R(0, 0, 15, 20, a) + R(15, 0, 15, 20, b); break;
    case 'v3': g = R(0, 0, 10, 20, a) + R(10, 0, 10, 20, b) + R(20, 0, 10, 20, d); break;
    case 'stripes': case 'starsstripes': { const sh = 20 / sn; for (let i = 0; i < sn; i++) g += R(0, +(i * sh).toFixed(3), 30, +(sh + .05).toFixed(3), i % 2 ? b : a); if (f.l === 'starsstripes') g += R(0, 0, 12.5, +(sh * Math.ceil(sn / 2)).toFixed(3), d); break; }
    case 'vstripes': { const n = Math.min(sn, 11), sw = 30 / n; for (let i = 0; i < n; i++) g += R(+(i * sw).toFixed(3), 0, +(sw + .05).toFixed(3), 20, i % 2 ? b : a); break; }
    case 'cross': g = R(0, 0, 30, 20, a) + R(12, 0, 6, 20, b) + R(0, 7, 30, 6, b); break;
    case 'nordic': g = R(0, 0, 30, 20, a) + R(8, 0, 6, 20, b) + R(0, 7, 30, 6, b) + R(9.5, 0, 3, 20, d) + R(0, 8.5, 30, 3, d); break;
    case 'nordic1': g = R(0, 0, 30, 20, a) + R(8.5, 0, 4, 20, b) + R(0, 8, 30, 4, b); break;
    case 'saltire': g = R(0, 0, 30, 20, a) + `<path d="M0 0 L30 20 M30 0 L0 20" stroke="${b}" stroke-width="3.4"/>`; break;
    case 'union': g = R(0, 0, 30, 20, a) + `<path d="M0 0 L30 20 M30 0 L0 20" stroke="${b}" stroke-width="3.6"/><path d="M0 0 L30 20 M30 0 L0 20" stroke="${d}" stroke-width="1.3"/>` + R(12, 0, 6, 20, b) + R(0, 7, 30, 6, b) + R(13, 0, 4, 20, d) + R(0, 8, 30, 4, d); break;
    case 'diag': g = R(0, 0, 30, 20, a) + Pth('M0 20 L30 0 L30 20 Z', b); break;
    case 'diag2': g = R(0, 0, 30, 20, a) + Pth('M0 0 L30 20 L0 20 Z', b); break;
    case 'bend': g = R(0, 0, 30, 20, a) + Pth('M0 20 L30 0 L30 20 Z', d) + `<path d="M0 20 L30 0" stroke="${q === a ? '#f2c230' : q}" stroke-width="5"/><path d="M0 20 L30 0" stroke="${b}" stroke-width="3"/>`; break;
    case 'tri': g = R(0, 0, 30, 10, b) + R(0, 10, 30, 10, d) + Pth('M0 0 L13 10 L0 20 Z', a); break;
    case 'tri3': g = R(0, 0, 30, 6.67, b) + R(0, 6.67, 30, 6.67, d) + R(0, 13.33, 30, 6.67, q) + Pth('M0 0 L12 10 L0 20 Z', a); break;
    case 'chevron': g = R(0, 0, 30, 10, b) + R(0, 10, 30, 10, d) + Pth('M0 0 L16 10 L0 20 Z', q) + Pth('M0 0 L12 10 L0 20 Z', a); break;
    case 'pall': g = R(0, 0, 30, 10, b) + R(0, 10, 30, 10, d) + `<path d="M0 0 L13 10 L30 10 M0 20 L13 10" stroke="${q}" stroke-width="5" fill="none"/><path d="M0 0 L13 10 L30 10 M0 20 L13 10" stroke="${a}" stroke-width="2.6" fill="none"/>` + Pth('M0 3 L9 10 L0 17 Z', a); break;
    case 'hoistband': g = R(0, 0, 30, 10, b) + R(0, 10, 30, 10, d) + R(0, 0, 10, 20, a); break;
    case 'canton': g = R(0, 0, 30, 20, a) + R(0, 0, 13, 10, b); break;
    case 'border': g = R(0, 0, 30, 20, b) + R(3, 3, 24, 14, a); break;
    case 'frame': g = R(0, 0, 30, 20, b) + R(1.6, 1.6, 26.8, 16.8, d) + R(3.2, 3.2, 23.6, 13.6, a); break;
    case 'quad': g = R(0, 0, 15, 10, a) + R(15, 0, 15, 10, b) + R(0, 10, 15, 10, b) + R(15, 10, 15, 10, a); break;
    case 'quadcross': g = R(0, 0, 15, 10, a) + R(15, 0, 15, 10, b) + R(0, 10, 15, 10, b) + R(15, 10, 15, 10, a) + R(13, 0, 4, 20, d) + R(0, 8, 30, 4, d); break;
    case 'xquad': g = Pth('M0 0 L30 0 L15 10 Z', a) + Pth('M30 0 L30 20 L15 10 Z', b) + Pth('M0 20 L30 20 L15 10 Z', a) + Pth('M0 0 L0 20 L15 10 Z', b) + `<path d="M0 0 L30 20 M30 0 L0 20" stroke="${d}" stroke-width="2.6"/>`; break;
    case 'circle': g = R(0, 0, 30, 20, a) + `<circle cx="15" cy="10" r="6" fill="${b}"/>`; break;
    case 'lozenge': g = R(0, 0, 30, 20, a) + Pth('M15 2 L28 10 L15 18 L2 10 Z', b) + `<circle cx="15" cy="10" r="4.6" fill="${d}"/>`; break;
    case 'rays': { g = R(0, 0, 30, 20, a); for (let i = 0; i < 16; i += 2) { const t1 = i / 16 * Math.PI * 2, t2 = (i + 1) / 16 * Math.PI * 2; g += Pth(`M15 10 L${(15 + 40 * Math.cos(t1)).toFixed(1)} ${(10 + 40 * Math.sin(t1)).toFixed(1)} L${(15 + 40 * Math.cos(t2)).toFixed(1)} ${(10 + 40 * Math.sin(t2)).toFixed(1)} Z`, b); } g = `<g>${g}</g>`; break; }
    case 'checker': { for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) g += R(x * 5, y * 5, 5, 5, (x + y) % 2 ? b : a); break; }
    case 'wavy': g = R(0, 0, 30, 20, a) + Pth('M0 7 Q7.5 4 15 7 T30 7 L30 13 Q22.5 16 15 13 T0 13 Z', b) + `<path d="M0 7 Q7.5 4 15 7 T30 7 M0 13 Q7.5 10 15 13 T30 13" stroke="${d}" stroke-width=".9" fill="none"/>`; break;
    case 'mountain': g = R(0, 0, 30, 20, a) + Pth('M0 20 L9 9 L14 14 L20 6 L30 17 L30 20 Z', b) + Pth('M18.2 8.3 L20 6 L21.9 8.4 L20.6 9 L20 8 L19.3 9 Z', d); break;
    default: g = R(0, 0, 30, 20, a);
  }
  // emblem: colour, position (centre, canton or hoist), size and count
  const ec = FLAG_HEX.test(f.ec) ? f.ec : f.l === 'starsstripes' ? b : d, ep = ['c', 'k', 'h'].includes(f.ep) ? f.ep : FLAG_CANTON.includes(f.l) ? 'k' : FLAG_HOIST.includes(f.l) ? 'h' : 'c';
  const sc = ({ 1: .72, 2: 1, 3: 1.3 })[f.es] || 1, en = f.en ? Math.max(1, Math.min(15, Math.round(f.en) || 1)) : 0;
  const [cx, cy, k0] = ep === 'k' ? [f.l === 'starsstripes' ? 6.25 : 6.5, f.l === 'starsstripes' ? 20 / sn * Math.ceil(sn / 2) / 2 : 5, .8] : ep === 'h' ? [f.l === 'hoistband' ? 5 : 5.2, 10, .78] : [15, 10, 1];
  const r = 5 * sc * k0, e = ec, fx = n => (+n).toFixed(2);
  const starP = (x, y, rr, pts, inner) => { let p = ''; for (let i = 0; i < pts * 2; i++) { const t = Math.PI / pts * i - Math.PI / 2, s = i % 2 ? rr * inner : rr; p += (i ? 'L' : 'M') + fx(x + s * Math.cos(t)) + ' ' + fx(y + s * Math.sin(t)); } return p + 'Z'; };
  const star = (x, y, rr, col) => Pth(starP(x, y, rr, 5, .45), col);
  const crescent = (x, y, rr) => Pth(`M${fx(x + rr * .3)} ${fx(y - rr * .95)} A${fx(rr)} ${fx(rr)} 0 1 0 ${fx(x + rr * .3)} ${fx(y + rr * .95)} A${fx(rr * .8)} ${fx(rr * .8)} 0 1 1 ${fx(x + rr * .3)} ${fx(y - rr * .95)} Z`, e);
  const S = (p, sw) => `<path d="${p}" stroke="${e}" stroke-width="${fx(sw)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  const x = cx, y = cy;
  const em = {
    star: () => star(x, y, r * .95, e), star6: () => Pth(starP(x, y, r, 6, .55), e), star8: () => Pth(starP(x, y, r, 8, .4), e),
    stars: () => { const n = en || 3; if (n === 1) return star(x, y, r * .8, e); if (n > 5) { const cols = Math.ceil(Math.sqrt(n * 1.6)), rows = Math.ceil(n / cols), sx = r * 2 / cols, sy = r * 1.6 / rows, rr = Math.min(sx, sy) * .5; let s = ''; for (let i = 0; i < n; i++) { const rw = Math.floor(i / cols), inRow = Math.min(cols, n - rw * cols), cI = i - rw * cols; s += star(x - sx * (inRow - 1) / 2 + sx * cI, y - sy * (rows - 1) / 2 + sy * rw, rr, e); } return s; } const sp = Math.min(r * 2.4 / (n - 1), r * .95), rr = Math.min(r * .55, sp * .55); let s = ''; for (let i = 0; i < n; i++) s += star(x - sp * (n - 1) / 2 + sp * i, y, rr, e); return s; },
    starring: () => { const n = en || 12; let s = ''; for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2 - Math.PI / 2; s += star(x + r * .8 * Math.cos(t), y + r * .8 * Math.sin(t), r * .2, e); } return s; },
    sun: () => `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r * .64)}" fill="${e}"/>` + [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const t = i * Math.PI / 4; return `<line x1="${fx(x + r * .84 * Math.cos(t))}" y1="${fx(y + r * .84 * Math.sin(t))}" x2="${fx(x + r * 1.2 * Math.cos(t))}" y2="${fx(y + r * 1.2 * Math.sin(t))}" stroke="${e}" stroke-width="${fx(r * .22)}"/>`; }).join(''),
    moon: () => crescent(x, y, r * .9), moonstar: () => crescent(x - r * .2, y, r * .85) + star(x + r * .55, y, r * .35, e),
    circle: () => `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r * .8)}" fill="${e}"/>`, ring: () => `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r * .75)}" stroke="${e}" stroke-width="${fx(r * .25)}" fill="none"/>`,
    shield: () => Pth(`M${fx(x - r * .8)} ${fx(y - r)} H${fx(x + r * .8)} V${fx(y)} Q${fx(x + r * .8)} ${fx(y + r * .8)} ${fx(x)} ${fx(y + r * 1.1)} Q${fx(x - r * .8)} ${fx(y + r * .8)} ${fx(x - r * .8)} ${fx(y)} Z`, e),
    cross: () => R(fx(x - r * .24), fx(y - r), fx(r * .48), fx(r * 2), e) + R(fx(x - r), fx(y - r * .24), fx(r * 2), fx(r * .48), e),
    triangle: () => Pth(`M${fx(x)} ${fx(y - r)} L${fx(x + r)} ${fx(y + r * .8)} L${fx(x - r)} ${fx(y + r * .8)} Z`, e),
    diamond: () => Pth(`M${fx(x)} ${fx(y - r)} L${fx(x + r)} ${fx(y)} L${fx(x)} ${fx(y + r)} L${fx(x - r)} ${fx(y)} Z`, e),
    crown: () => Pth(`M${fx(x - r)} ${fx(y + r * .6)} L${fx(x - r)} ${fx(y - r * .35)} L${fx(x - r * .5)} ${fx(y + r * .1)} L${fx(x)} ${fx(y - r * .75)} L${fx(x + r * .5)} ${fx(y + r * .1)} L${fx(x + r)} ${fx(y - r * .35)} L${fx(x + r)} ${fx(y + r * .6)} Z`, e) + [-1, 0, 1].map(i => `<circle cx="${fx(x + i * r)}" cy="${fx(y - (i ? r * .35 : r * .75) - r * .16)}" r="${fx(r * .16)}" fill="${e}"/>`).join(''),
    laurel: () => { let s = ''; for (const side of [-1, 1]) for (let i = 0; i < 6; i++) { const t = (Math.PI * .15) + i / 5 * Math.PI * .7, lx = x + side * r * .85 * Math.sin(t), ly = y + r * .85 * Math.cos(t); s += `<ellipse cx="${fx(lx)}" cy="${fx(ly)}" rx="${fx(r * .17)}" ry="${fx(r * .36)}" transform="rotate(${fx(side * (90 - t * 180 / Math.PI) + (side > 0 ? 0 : 180))} ${fx(lx)} ${fx(ly)})" fill="${e}"/>`; } return s; },
    anchor: () => S(`M${fx(x)} ${fx(y - r * .6)} V${fx(y + r)} M${fx(x - r * .5)} ${fx(y - r * .25)} H${fx(x + r * .5)} M${fx(x - r * .85)} ${fx(y + r * .35)} Q${fx(x - r * .7)} ${fx(y + r * 1.05)} ${fx(x)} ${fx(y + r)} Q${fx(x + r * .7)} ${fx(y + r * 1.05)} ${fx(x + r * .85)} ${fx(y + r * .35)}`, r * .2) + `<circle cx="${fx(x)}" cy="${fx(y - r * .8)}" r="${fx(r * .22)}" stroke="${e}" stroke-width="${fx(r * .16)}" fill="none"/>`,
    gear: () => { let s = `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r * .55)}" stroke="${e}" stroke-width="${fx(r * .3)}" fill="none"/>`; for (let i = 0; i < 8; i++) s += `<rect x="${fx(x - r * .14)}" y="${fx(y - r)}" width="${fx(r * .28)}" height="${fx(r * .32)}" fill="${e}" transform="rotate(${i * 45} ${fx(x)} ${fx(y)})"/>`; return s; },
    tree: () => Pth(`M${fx(x)} ${fx(y - r)} L${fx(x + r * .55)} ${fx(y - r * .25)} L${fx(x + r * .3)} ${fx(y - r * .25)} L${fx(x + r * .75)} ${fx(y + r * .35)} L${fx(x + r * .45)} ${fx(y + r * .35)} L${fx(x + r * .9)} ${fx(y + r * .8)} L${fx(x - r * .9)} ${fx(y + r * .8)} L${fx(x - r * .45)} ${fx(y + r * .35)} L${fx(x - r * .75)} ${fx(y + r * .35)} L${fx(x - r * .3)} ${fx(y - r * .25)} L${fx(x - r * .55)} ${fx(y - r * .25)} Z`, e) + R(fx(x - r * .12), fx(y + r * .8), fx(r * .24), fx(r * .3), e),
    peak: () => Pth(`M${fx(x - r)} ${fx(y + r * .7)} L${fx(x - r * .3)} ${fx(y - r * .4)} L${fx(x)} ${fx(y)} L${fx(x + r * .35)} ${fx(y - r * .85)} L${fx(x + r)} ${fx(y + r * .7)} Z`, e),
    waves: () => S(`M${fx(x - r)} ${fx(y - r * .3)} q${fx(r * .25)} ${fx(-r * .3)} ${fx(r * .5)} 0 t${fx(r * .5)} 0 t${fx(r * .5)} 0 t${fx(r * .5)} 0 M${fx(x - r)} ${fx(y + r * .35)} q${fx(r * .25)} ${fx(-r * .3)} ${fx(r * .5)} 0 t${fx(r * .5)} 0 t${fx(r * .5)} 0 t${fx(r * .5)} 0`, r * .2),
    bolt: () => Pth(`M${fx(x + r * .25)} ${fx(y - r)} L${fx(x - r * .55)} ${fx(y + r * .15)} L${fx(x - r * .05)} ${fx(y + r * .15)} L${fx(x - r * .3)} ${fx(y + r)} L${fx(x + r * .55)} ${fx(y - r * .2)} L${fx(x + r * .05)} ${fx(y - r * .2)} Z`, e),
    leaf: () => Pth(`M${fx(x)} ${fx(y - r)} Q${fx(x + r * .9)} ${fx(y - r * .1)} ${fx(x)} ${fx(y + r * .75)} Q${fx(x - r * .9)} ${fx(y - r * .1)} ${fx(x)} ${fx(y - r)} Z`, e) + `<path d="M${fx(x)} ${fx(y - r * .6)} V${fx(y + r)}" stroke="${e}" stroke-width="${fx(r * .12)}"/>`,
    tower: () => Pth(`M${fx(x - r * .6)} ${fx(y + r)} V${fx(y - r * .5)} H${fx(x - r * .8)} V${fx(y - r)} H${fx(x - r * .45)} V${fx(y - r * .75)} H${fx(x - r * .15)} V${fx(y - r)} H${fx(x + r * .15)} V${fx(y - r * .75)} H${fx(x + r * .45)} V${fx(y - r)} H${fx(x + r * .8)} V${fx(y - r * .5)} H${fx(x + r * .6)} V${fx(y + r)} Z`, e),
    swords: () => S(`M${fx(x - r * .8)} ${fx(y - r * .8)} L${fx(x + r * .65)} ${fx(y + r * .65)} M${fx(x + r * .8)} ${fx(y - r * .8)} L${fx(x - r * .65)} ${fx(y + r * .65)}`, r * .18) + S(`M${fx(x + r * .35)} ${fx(y + r * .8)} L${fx(x + r * .8)} ${fx(y + r * .35)} M${fx(x - r * .35)} ${fx(y + r * .8)} L${fx(x - r * .8)} ${fx(y + r * .35)}`, r * .2),
    eagle: () => Pth(`M${fx(x - r)} ${fx(y - r * .45)} Q${fx(x - r * .55)} ${fx(y - r * .1)} ${fx(x - r * .2)} ${fx(y - r * .15)} L${fx(x)} ${fx(y - r * .55)} L${fx(x + r * .2)} ${fx(y - r * .15)} Q${fx(x + r * .55)} ${fx(y - r * .1)} ${fx(x + r)} ${fx(y - r * .45)} Q${fx(x + r * .75)} ${fx(y + r * .25)} ${fx(x + r * .25)} ${fx(y + r * .2)} L${fx(x + r * .3)} ${fx(y + r * .9)} L${fx(x)} ${fx(y + r * .6)} L${fx(x - r * .3)} ${fx(y + r * .9)} L${fx(x - r * .25)} ${fx(y + r * .2)} Q${fx(x - r * .75)} ${fx(y + r * .25)} ${fx(x - r)} ${fx(y - r * .45)} Z`, e) + `<circle cx="${fx(x)}" cy="${fx(y - r * .65)}" r="${fx(r * .2)}" fill="${e}"/>`,
    atom: () => [0, 60, 120].map(t => `<ellipse cx="${fx(x)}" cy="${fx(y)}" rx="${fx(r)}" ry="${fx(r * .36)}" stroke="${e}" stroke-width="${fx(r * .13)}" fill="none" transform="rotate(${t} ${fx(x)} ${fx(y)})"/>`).join('') + `<circle cx="${fx(x)}" cy="${fx(y)}" r="${fx(r * .2)}" fill="${e}"/>`,
    flame: () => Pth(`M${fx(x)} ${fx(y - r)} Q${fx(x + r * .2)} ${fx(y - r * .4)} ${fx(x + r * .55)} ${fx(y - r * .15)} Q${fx(x + r * .85)} ${fx(y + r * .3)} ${fx(x + r * .45)} ${fx(y + r * .75)} Q${fx(x)} ${fx(y + r * 1.05)} ${fx(x - r * .45)} ${fx(y + r * .75)} Q${fx(x - r * .85)} ${fx(y + r * .3)} ${fx(x - r * .4)} ${fx(y - r * .25)} Q${fx(x - r * .2)} ${fx(y)} ${fx(x - r * .1)} ${fx(y + r * .1)} Q${fx(x - r * .25)} ${fx(y - r * .6)} ${fx(x)} ${fx(y - r)} Z`, e),
    heart: () => Pth(`M${fx(x)} ${fx(y + r * .85)} C${fx(x - r * 1.3)} ${fx(y)} ${fx(x - r * .7)} ${fx(y - r * 1.05)} ${fx(x)} ${fx(y - r * .35)} C${fx(x + r * .7)} ${fx(y - r * 1.05)} ${fx(x + r * 1.3)} ${fx(y)} ${fx(x)} ${fx(y + r * .85)} Z`, e)
  }[FLAG_EMBLEMS.includes(f.e) ? f.e : 'none'];
  return `<svg ${ns ? 'xmlns="http://www.w3.org/2000/svg" ' : ''}class="flag" width="${w}" height="${h}" viewBox="0 0 30 20" preserveAspectRatio="none" role="img" aria-label="flag"><g>${g}${em ? em() : ''}</g>${f.fr ? '<rect x=".9" y=".9" width="28.2" height="18.2" fill="none" stroke="#ffd25e" stroke-width="1.8"/><rect x=".2" y=".2" width="29.6" height="19.6" fill="none" stroke="#7a5612" stroke-width=".45"/><rect x="2" y="2" width="26" height="16" fill="none" stroke="rgba(255,240,190,.55)" stroke-width=".35"/>' : '<rect x=".25" y=".25" width="29.5" height="19.5" fill="none" stroke="rgba(0,0,0,.35)" stroke-width=".5"/>'}</svg>`;
}
const AUTO_TAX = .6; // share of one tax collection that arrives automatically every 10 minutes
const NUKE = { tech: 100, rank: 6, cash: 150e6, steel: 4000, oil: 4000, goods: 2500, upkeep: 3e5 };
// mandatory international inspections for every nuclear nation: charged automatically once a day
const INSPECT = { base: 10e6, pct: .01, cap: 80e6, warhead: 1.5, everyH: 24 };
// a dirty bomb: a conventional missile carrying radioactive material. Far cheaper than a nuclear program; leaves a radioactive cloud over one province for 24 hours
const DIRTY = { tech: 45, mun: 100, rank: 3, cash: 15e6, steel: 500, oil: 500, goods: 300, cdH: 12, h: 24, aggr: 25, km: 380 };
// imperial overstretch: only the very biggest empires (28 provinces or more) pay upkeep for every province past 27 (rising steeply), lose stability and risk far-off provinces breaking away
// paying off the World Council to lift sanctions or rogue status at once: 25% of the treasury (at least $50M), double for a rogue state, and doubling again for every payoff in the last 7 days
const BRIBE = { pct: .25, min: 50e6, rogueX: 2, windowD: 7 };
// province limit: 8 + 3 per rank (Chieftain 8 ... Sovereign 29 ... World Power 38). Above it, every extra province costs heavy upkeep,
// and after a 24-hour warning the farthest extra provinces rebel and become free land, a few an hour. Far-flung land (over 3,000 km
// from the capital) also tends to break away. The Rising Power is exempt.
const OVER = { base: 8, per: 3, cost: .00015, graceH: 24, rebelP: .05, rebelPer: .02, st: .3, farKm: 3000, farP: .0015, farMin: 6 };
// ADMINISTRATION: every province costs administration points. Core land (held 7+ days) costs 1, a colony (newer) costs 2, and land more than
// 3,000 km from the capital costs 1 more; the capital is free. Capacity = 10 + 3 per rank + 4 per level of Administrative offices (AI nations +6).
// Over capacity: production and taxes fall 3% per point (up to −45%), stability drains and there is upkeep. Only when badly over (25%+) and
// after a 24-hour warning do the farthest colonies break away and become free land. The Rising Power is exempt.
const ADMIN = { base: 20, per: 5, ai: 6, coreD: 7, colony: 2, far: 1, farKm: 3000,
  office: { max: 5, cap: 4, cash: 2e7, steel: 600, goods: 400, cdH: 6 },
  over: { prod: .03, prodMax: .45, st: .1, stMax: 1.5, cost: .00004, severe: 1.25, graceH: 24, p: .01, pMax: .08, stFloor: 30, costMax: .02 } };
// VASSALS: win a capital siege choosing "make vassal" and the nation survives as your vassal: it keeps its land, pays tribute every 10 minutes
// (half a tax collection and 10% of its production), and neither side can attack the other. After 48 hours it may declare independence (war).
const OUTPOST = { max: 4, rank: 2, stageKm: 2500, def: 1.1, cdH: 2, conv: { cash: 25e6, steel: 500, oil: 300 }, est: { cash: 60e6, steel: 1000, oil: 600 } };
const VASSAL = { tax: .5, res: .1, loot: .1, freeH: 48 };
// a launchable warhead: only for nations that already hold a deterrent, and very expensive
// nuclear warheads are a last resort: very expensive, slow to build, two weeks between launches, only after 24 hours of war, and devastating
const WARHEAD = { tech: 120, rank: 7, cash: 500e6, steel: 9000, oil: 9000, goods: 6000, buildH: 24, holdH: 24, cdD: 14, warH: 24, km: 2600, nukedH: 72, falloutH: 48, winterH: 36, angerD: 7, aiWar: .5 };
// conventional and non-nuclear heavy weapons: real options short of a nuke
const HEAVY = {
  ballistic: { n: 'Ballistic missile', ic: '🚀', tech: 75, mun: 120, rank: 3, cash: 3e7, steel: 900, oil: 700, goods: 200, cdH: 6, aggr: 14, domeX: .5, pop: .04, troops: .1, gdp: .05, infra: 1, st: 6 },
  bombard: { n: 'Naval bombardment', ic: '⚓', tech: 10, mun: 40, rank: 2, ships: 10, oilPer: 5, cdH: 3, aggr: 7 },
  cyber: { n: 'Cyber attack', ic: '💻', tech: 40, mun: 0, rank: 2, cash: 2e7, goods: 300, cdH: 8, aggr: 5, h: 12, tax: .75, research: 1.5, trace: .35 },
  emp: { n: 'EMP strike', ic: '⚡', tech: 100, mun: 150, rank: 5, cash: 8e7, steel: 1500, oil: 1500, goods: 1000, cdH: 24, aggr: 25, h: 12, air: .3, gdp: .08, tax: .6 },
  drones: { n: 'Drone swarm', ic: '🛸', tech: 20, mun: 30, rank: 2, cash: 5e6, oil: 200, goods: 300, cdH: 2, aggr: 6, troops: .06, air: .04 },
  hypersonic: { n: 'Hypersonic missile', ic: '☄', tech: 125, mun: 200, rank: 5, cash: 6e7, steel: 1200, oil: 900, goods: 400, cdH: 12, aggr: 18, pop: .06, troops: .15, gdp: .07, infra: 2, st: 8 },
  blockade: { n: 'Naval blockade', ic: '⛴', tech: 25, mun: 40, rank: 2, ships: 20, oilPer: 3, cdH: 12, aggr: 8, h: 12, tax: .7, gdp: .95 },
  raid: { n: 'Special forces raid', ic: '🎯', tech: 50, mun: 25, rank: 3, cash: 1.5e7, cdH: 8, aggr: 10, steal: .04, stealMax: 1e8, res: .1 },
  artillery: { n: 'Artillery barrage', ic: '💥', tech: 5, mun: 20, rank: 1, cash: 3e6, steel: 150, oil: 60, cdH: 2, aggr: 5, troops: .035, fort: 1 },
  cruise: { n: 'Cruise missile', ic: '🔥', tech: 35, mun: 50, rank: 2, cash: 1.5e7, steel: 400, oil: 400, goods: 100, cdH: 4, aggr: 8, domeX: 1, infra: 1, troops: .03 },
  carpet: { n: 'Carpet bombing', ic: '✈', tech: 30, mun: 60, rank: 3, air: 40, oilPer: 4, cdH: 6, aggr: 16, pop: .025, troops: .07, infra: 1, st: 5 },
  sub: { n: 'Submarine strike', ic: '🌊', tech: 60, mun: 60, rank: 3, ships: 5, cash: 1e7, steel: 300, oil: 300, cdH: 6, aggr: 9, sink: .2 },
  orbital: { n: 'Orbital strike', ic: '🛰', tech: 175, mun: 400, rank: 7, cash: 2.5e8, steel: 4000, oil: 2000, goods: 3000, cdH: 48, aggr: 30, pop: .1, troops: .25, gdp: .12, infra: 3, st: 15 },
};
const EFFKEYS = ['tr', 'ap', 'st', 'pop', 'troops', 'tech', 'food', 'oil', 'steel', 'goods', 'infra', 'fort', 'train', 'aggr', 'gdp', 'unemp', 'infl', 'health', 'edu', 'debt', 'ships', 'air', 'spies', 'morale'];
const DEFBUDGET = { spend: 15, mil: 30, health: 25, edu: 25, infra: 20 };
const COVERT = {
  steal: { n: 'Steal technology', spies: 3, cost: 150000, d: 'Copy research from a more advanced nation (+1 tech level).' },
  sabotage: { n: 'Sabotage industry', spies: 2, cost: 100000, d: 'Destroy part of their stockpiles and damage infrastructure.' },
  unrest: { n: 'Incite unrest', spies: 2, cost: 100000, d: 'Fund protests: their stability −10 and approval −5.' },
  rig: { n: 'Interfere in election', spies: 3, cost: 200000, d: 'Swing their next election against the government (democracies only). Target yourself to swing your own election in your favour.' },
  rebellion: { n: 'Stir up rebellion', spies: 4, cost: 400000, d: 'Arm separatists in one of their outer provinces. For 24 hours it may break away and declare independence — far more likely if their stability is low.' },
  fakenews: { n: 'Plant fake news', spies: 2, cost: 150000, d: 'Flood their media with lies: approval −8, stability −4, and the world blames them (+8 aggression).' },
  siphon: { n: 'Siphon funds', spies: 3, cost: 250000, d: 'Quietly move 2% of their treasury (up to $50M) into your own.' },
  recon: { n: 'Satellite reconnaissance', spies: 1, cost: 50000, d: 'Photograph their whole war machine: a full intelligence report on their army, fleet, air force, agents, treasury, generals and weapons.' },
  blackout: { n: 'Sabotage the power grid', spies: 3, cost: 300000, d: 'Black out their cities: production −40% and GDP −3% for 8 hours.' },
  crash: { n: 'Crash their stock market', spies: 3, cost: 300000, d: 'Spread panic on their exchanges: GDP −4% at once and tax revenue −20% for 8 hours.' },
  defect: { n: 'Turn a double agent', spies: 2, cost: 200000, d: 'Flip one of their agents to your side: they lose 2 agents and you gain 1.' },
  poison: { n: 'Contaminate food supplies', spies: 2, cost: 150000, d: 'Spoil a third of their food stockpile. Health −6.' },
  assassinate: { n: 'Assassinate a general', spies: 5, cost: 2000000, d: 'Kill their best general (the one with the most stars). Harder than other operations, and if your agents are caught the world finds out and they get a 48-hour just cause against you.' }
};
// World Council resolutions. kind: 'punish' and 'protect' name a target nation; 'global' applies to everyone. h = how long it lasts.
const RESOLUTIONS = {
  // measures against a nation
  sanction: { kind: 'punish', h: 24, n: 'Impose sanctions', d: 'Declares the target a rogue state for at least 12 hours: full trade embargo, trade agreements cancelled, allies walk away, and the world may attack it freely at +15% strength.' },
  embargo: { kind: 'punish', h: 24, n: 'Trade embargo', d: 'For 24 hours the target cannot use the world market and every trade agreement it has is suspended.' },
  armsEmb: { kind: 'punish', h: 36, n: 'Arms embargo', d: 'For 36 hours no nation may sell the target weapons: it cannot build warships or aircraft, and recruiting costs twice as much.' },
  freeze: { kind: 'punish', h: 24, n: 'Freeze foreign assets', d: 'A quarter of the target\'s treasury is frozen in foreign banks for 24 hours. The money comes back when the freeze ends or is lifted.' },
  condemn: { kind: 'punish', h: 24, n: 'Formal condemnation', d: 'A public rebuke: the target loses 10 approval and 8 stability, gains 20 aggression (a step closer to sanctions), and AI nations shun it for 24 hours.' },
  inspect: { kind: 'punish', h: 72, n: 'Nuclear inspections', d: 'Inspectors dismantle any warhead the target is still assembling (an armed one stays), and it cannot begin another for 72 hours. Only for nations with a nuclear program.' },
  // support for a nation
  ceasefire: { kind: 'protect', h: 12, n: 'Ceasefire order', d: 'For 12 hours no battles, missile or air strikes, or nuclear launches may happen between the target and anyone it is at war with. The wars stay declared, so use the time to negotiate.' },
  guarantee: { kind: 'protect', h: 48, n: 'Security guarantee', d: 'For 48 hours the target\'s provinces defend 20% better, and anyone who attacks it gains twice the usual aggression, which brings sanctions much sooner.' },
  aid: { kind: 'protect', h: 0, n: 'Humanitarian aid', d: 'Every nation that votes yes sends 1% of its treasury (up to $2M) and 5% of its food (up to 300). The target also gains 10 health and 6 stability. Not for rogue states.' },
  lift: { kind: 'protect', h: 0, n: 'Lift sanctions', d: 'Ends any embargo, arms embargo, asset freeze (the money comes back), condemnation and rogue-state status on the target, and lowers its aggression to 30. Not within 72 hours of it launching a nuclear strike.' },
  // worldwide treaties
  climate: { kind: 'global', h: 24, n: 'Climate accord', d: 'For 24 hours oil output falls 15% worldwide, and every nation gains 3 approval.' },
  arms: { kind: 'global', h: 24, n: 'Arms reduction treaty', d: 'For 24 hours military upkeep is 20% cheaper, but invasions cost 50% more.' },
  freetrade: { kind: 'global', h: 24, n: 'Free trade pact', d: 'For 24 hours market spreads shrink: imports are cheaper and exports pay more for everyone.' },
  peacekeeping: { kind: 'global', h: 24, n: 'Peacekeeping mandate', d: 'For 24 hours armies need 30 minutes to mobilize after a declaration of war, and every invasion adds twice the usual aggression.' },
  npt: { kind: 'global', h: 48, n: 'Non-proliferation treaty', d: 'For 48 hours no nation may start a nuclear program or assemble a warhead. Weapons already armed are not affected.' },
  health: { kind: 'global', h: 24, n: 'Global health initiative', d: 'For 24 hours every nation\'s health drifts 12 higher (faster population growth) and pandemics kill half as many people. Every nation pays 0.5% of its treasury when it passes.' },
  science: { kind: 'global', h: 24, n: 'Science cooperation', d: 'For 24 hours research costs 25% less for every nation.' },
  food: { kind: 'global', h: 24, n: 'Food security program', d: 'For 24 hours farms everywhere produce 20% more food and the world food price is 15% lower.' },
  debt: { kind: 'global', h: 24, n: 'Debt relief', d: 'Every nation in debt has 20% of it forgiven the moment it passes. Printing the money pushes inflation 1 point higher worldwide for 24 hours.' },
  nonukes: { kind: 'global', h: 24, n: 'Nuclear weapons ban', d: 'For 24 hours no nation may launch a nuclear missile, drop a dirty bomb or test a nuclear weapon.' },
  tariffs: { kind: 'global', h: 24, n: 'Tariff war', d: 'For 24 hours market fees double and trade routes pay half their usual bonus. Self-sufficient nations come out ahead.' },
  freemarket: { kind: 'global', h: 72, n: 'Free market week', d: 'For 72 hours market fees are slashed, every nation earns 3% more tax, and GDP is 2% higher everywhere.' },
  truce: { kind: 'global', h: 24, n: 'World truce', d: 'For 24 hours no nation may declare a new war. Wars already declared go on.' },
  // pacts and declarations
  pact: { kind: 'pact', h: 72, n: 'Collective defense pact', d: 'Every nation that votes yes becomes a member for 72 hours. If anyone attacks a member (a battle, a strike or a nuke), every other member automatically declares war on the attacker. Choose whether it covers attacks by AI nations only or by anyone.' },
  custom: { kind: 'custom', h: 48, n: 'Custom resolution', d: 'Write your own resolution (up to 500 characters). If it passes it is listed as in force with everyone who voted for it, for 24, 48 or 72 hours. It is a public commitment: the game cannot enforce typed text. AI nations do not vote on custom resolutions.' }
};
const EVENTS = {
  recession: { n: 'Global Recession', d: 'Financial markets have crashed worldwide. Economies everywhere are contracting.', h: 8, mod: { gdp: .9, tax: .85, unemp: 3 },
    card: { t: 'Respond to the global recession', d: 'Factories are closing and unemployment is rising across the world. How will your government respond?', o: [['Large stimulus package', { tr: -3, unemp: -3, debt: 3 }], ['Cut taxes temporarily', { tr: -1.5, ap: 4, unemp: -1 }], ['Austerity — balance the budget', { tr: 2, unemp: 2, ap: -5 }]] } },
  pandemic: { n: 'Global Pandemic', d: 'A new virus is spreading across every continent. Nations with strong health systems will fare best.', h: 8, mod: { pandemic: 1, gdp: .95 },
    card: { t: 'The pandemic reaches your borders', d: 'Cases are rising quickly. Hospitals are preparing for a surge.', o: [['Strict lockdown', { pop: -.5, gdp: -4, ap: -3, health: 5 }], ['Emergency health funding', { tr: -2.5, health: 12, ap: 3 }], ['Keep everything open', { pop: -3, ap: -6 }]] } },
  oil: { n: 'Oil Crisis', d: 'A supply shock has sent oil prices soaring. Oil producers profit; importers suffer.', h: 8, mod: { price: { oil: 2.2 }, infl: 3 },
    card: { t: 'Oil prices are soaring', d: 'Fuel is suddenly very expensive. Transport and industry are under pressure.', o: [['Release strategic reserves', { oil: -80, ap: 4 }], ['Subsidize fuel', { tr: -2, ap: 3, infl: 1 }], ['Ration fuel', { ap: -4, oil: 60 }]] } },
  boom: { n: 'Commodity Boom', d: 'Global demand for steel and manufactured goods is surging.', h: 8, mod: { price: { steel: 1.8, goods: 1.4 }, gdp: 1.05 },
    card: { t: 'A commodity boom', d: 'Prices for steel and goods are surging worldwide.', o: [['Expand mining and factories', { tr: -1.5, steel: 80, goods: 40 }], ['Tax windfall profits', { tr: 2.5 }], ['Let the market run', { gdp: 2 }]] } },
  tech: { n: 'Technology Revolution', d: 'A breakthrough in computing is transforming economies. Research is cheaper for everyone.', h: 8, mod: { research: .6, gdp: 1.03 },
    card: { t: 'The technology revolution', d: 'New technology could transform your economy — if you invest.', o: [['National digital program', { tr: -2.5, tech: 1, edu: 4 }], ['Retrain affected workers', { tr: -1.5, unemp: -2 }], ['Wait and see', {}]] } },
  harvest: { n: 'Global Crop Failure', d: 'Droughts and blight have hit harvests worldwide. Food prices have doubled.', h: 8, mod: { price: { food: 2 }, food: .7, infl: 2 },
    card: { t: 'Food shortages', d: 'Global harvests have failed and food prices have doubled.', o: [['Import food at any cost', { tr: -2, food: 120 }], ['Ration food', { ap: -5, food: 40 }], ['Price controls', { ap: 3, infl: -1, food: -40 }]] } },
  finance: { n: 'Financial Crisis', d: 'Banks are failing and borrowing costs have spiked worldwide.', h: 8, mod: { rate: 4, infl: 2, gdp: .95 },
    card: { t: 'Banks are failing', d: 'Credit has frozen. Your largest banks need help.', o: [['Bail out the banks', { tr: -2.5, debt: 2, st: 3 }], ['Nationalize failing banks', { tr: -1, st: -2, gdp: -1 }], ['Let them fail', { unemp: 3, ap: -4 }]] } },
  peace: { n: 'Era of Peace', d: 'A wave of diplomacy is sweeping the world. Aggression fades faster and trade flourishes.', h: 8, mod: { aggr: 3, gdp: 1.03 },
    card: { t: 'A peace movement sweeps the world', d: 'Citizens everywhere are demanding disarmament and cooperation.', o: [['Cut the military budget', { troops: -100, tr: 2, ap: 4 }], ['Host a peace conference', { tr: -1, aggr: -20, ap: 2 }], ['Stay prepared', { st: 2 }]] } }
};

function UserError(msg) { const e = new Error(msg); e.user = true; return e; }
const fail = msg => { throw UserError(msg); };
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const num = v => Math.round(v).toLocaleString('en-US');
const money = v => (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
const moneyS = v => { const a = Math.abs(v), s = v < 0 ? '−$' : '$'; return a >= 1e12 ? s + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(0) + 'K' : s + Math.round(a); };

// ---------- decisions with real stakes ----------
// timed boosts (fields read like laws and wonders): gdp, tax and research are multipliers; ap, st and health are added to where they settle
const BOOST_KEYS = ['gdp', 'tax', 'research', 'def', 'ap', 'st', 'health', 'prod'];
const BOOST_TXT = { prod: v => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}% production`, gdp: v => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}% GDP`, tax: v => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}% tax revenue`, research: v => `${v < 1 ? '−' : '+'}${Math.round(Math.abs(1 - v) * 100)}% research costs`, def: v => `${v > 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}% defense`, ap: v => `${v > 0 ? '+' : '−'}${Math.abs(v)} approval`, st: v => `${v > 0 ? '+' : '−'}${Math.abs(v)} stability`, health: v => `${v > 0 ? '+' : '−'}${Math.abs(v)} health` };
const boostTxt = b => BOOST_KEYS.filter(k => b[k] != null).map(k => BOOST_TXT[k](b[k])).join(', ') + (b.h ? ` for ${b.h}h` : '');
// what a costly investment pays off in, from what the option is about
function payoffFor(e) {
  if ((e.tech || 0) > 0 || (e.edu || 0) > 0) return { research: .9, h: 24 };
  if ((e.troops || 0) > 0 || (e.fort || 0) > 0 || (e.train || 0) > 0 || (e.ships || 0) > 0 || (e.air || 0) > 0) return { def: 1.1, h: 24 };
  if ((e.gdp || 0) > 0 || (e.unemp || 0) < 0 || (e.infra || 0) > 0 || (e.goods || 0) > 0 || (e.steel || 0) > 0 || (e.oil || 0) > 0) return { gdp: 1.05, h: 24 };
  if ((e.health || 0) > 0 || (e.pop || 0) > 0 || (e.food || 0) > 0) return { health: 8, h: 24 };
  if ((e.st || 0) > (e.ap || 0) && (e.st || 0) > 0) return { st: 4, h: 24 };
  if ((e.ap || 0) > 0) return { ap: 4, h: 24 };
  return { tax: 1.05, h: 24 };
}
const DOUBLE = ['tr', 'debt', 'ap', 'st', 'pop', 'gdp', 'troops', 'ships', 'air', 'spies', 'aggr', 'unemp', 'infl', 'health', 'edu', 'morale', 'food', 'oil', 'steel', 'goods'];
const scaleEff = (e, k) => { const o = {}; for (const [x, v] of Object.entries(e)) o[x] = DOUBLE.includes(x) && typeof v === 'number' ? Math.round(v * k * 10) / 10 : v; return o; };
function enhanceEff(e) {
  if (!e || typeof e !== 'object') return e;
  // gambles: everything at stake is doubled, and the outcome also shapes the next 12 to 24 hours
  if (e.risk != null) { const ok = scaleEff(e.ok || {}, 2), bad = scaleEff(e.bad || {}, 2); ok.boost = payoffFor(e.ok || {}); bad.boost = { gdp: .95, h: 12 }; return { risk: e.risk, ok, bad }; }
  // costly investments (at least 1.5 tax collections, or a loan): they cost twice as much, and pay off for a whole day
  if ((e.tr || 0) <= -1.5 || (e.debt || 0) > 0) { const o = { ...e }; if (o.tr) o.tr = Math.round(o.tr * 2 * 10) / 10; o.boost = payoffFor(e); return o; }
  return e;
}
function enhanceDecks(cards, chains) {
  const card = c => c && c.o ? { ...c, o: c.o.map(o => [o[0], enhanceEff(o[1]), ...o.slice(2)]) } : c;
  const ch = {}; for (const k of Object.keys(chains)) ch[k] = card(chains[k]);
  return { cards: (cards || []).map(card), chains: ch };
}
function Core(PD, CARDS) {
  const P = PD.p, CN = PD.countries;
  CARDS = CARDS || [];
  const land = h => (P[h] ? P[h].j : []);
  const sea = h => (P[h] && P[h].s) || [];
  const nbrs = h => land(h).concat(sea(h));
  const pname = h => { const p = P[h]; if (!p) return 'Unknown'; return p.n === CN[p.ci] ? p.n : `${p.n}, ${CN[p.ci]}`; };
  // decisions with real stakes: costly investments pay off for a day, and gambles win and lose big (built from the card files, which stay as they are)
  const DEC = enhanceDecks(CARDS, CHAINS);
  let BL = {}; // the alliances of the world being worked on (set by world())
  const getCard = i => (typeof i === 'string' && i.startsWith('ev:')) ? (EVENTS[i.slice(3)] || {}).card : (typeof i === 'string' && i.startsWith('ch:')) ? DEC.chains[i.slice(3)] : DEC.cards[i];

  function computeOwn(A) {
    const best = {};
    for (const [u, n] of Object.entries(A)) for (const [h, ts] of Object.entries(n.hexes || {})) { if (!P[h]) continue; if (!best[h] || ts > best[h].ts) best[h] = { u, ts }; }
    const caps = Object.entries(A).sort((a, b) => a[1].created - b[1].created);
    for (const [u, n] of caps) if (P[n.cap] && !(best[n.cap] && best[n.cap].cap)) best[n.cap] = { u, ts: 0, cap: true };
    return best;
  }
  // global modifiers from the active world event and passed council resolutions
  function mods(ev, council, now) {
    const m = { gdp: 1, tax: 1, unemp: 0, infl: 0, rate: 0, price: {}, food: 1, oil: 1, research: 1, upkeep: 1, atkCost: 1, aggrDecay: 1, mobilize: 10, aggrPerAttack: 15, spread: 0, pandemic: 0, apBonus: 0, health: 0, pandemicCut: 1, npt: false, tradeMul: 1, nonukes: false, truce: false };
    if (ev && ev.key && EVENTS[ev.key] && now < ev.end) { const e = EVENTS[ev.key].mod; for (const [k, v] of Object.entries(e)) { if (k === 'price') Object.assign(m.price, v); else if (k === 'aggr') m.aggrDecay = v; else if (k === 'unemp' || k === 'infl' || k === 'rate' || k === 'pandemic') m[k] += v; else m[k] *= v; } }
    const act = (council && council.active) || {};
    const on = k => act[k] && act[k] > now;
    if (on('climate')) { m.oil *= .85; m.apBonus += 3; }
    if (on('arms')) { m.upkeep *= .8; m.atkCost *= 1.5; }
    if (on('freetrade')) m.spread = .05;
    if (on('peacekeeping')) { m.mobilize = 30; m.aggrPerAttack = 30; }
    if (on('npt')) m.npt = true;
    if (on('health')) { m.health += 12; m.pandemicCut = .5; }
    if (on('science')) m.research *= .75;
    if (on('food')) { m.food *= 1.2; m.price = { ...m.price, food: (m.price.food || 1) * .85 }; }
    if (on('debt')) m.infl += 1;
    if (on('nonukes')) m.nonukes = true;
    if (on('tariffs')) { m.spread -= .08; m.tradeMul = .5; }
    if (on('freemarket')) { m.spread = Math.max(m.spread, .06); m.tax *= 1.03; m.gdp *= 1.02; }
    if (on('truce')) m.truce = true;
    return m;
  }
  function world(A, cfg, now, ev, council, blocs, crisis, ext) { now = now || Date.now(); NOADM = !!(cfg && cfg.noAdmin); const W = { A, cfg: { ...DEFCFG, ...(cfg || {}) }, now, ev: ev || null, council: council || null, B: blocs || {}, CR: crisis || null, G: (ext && ext.games) || null, DIS: (ext && ext.dis) || [], changed: new Set(), news: [], notes: [], fallen: [] }; BL = W.B; W.m = mods(ev, council, now); if (W.CR && W.CR.key && now < W.CR.end && CRISES[W.CR.key] && CRISES[W.CR.key].during) for (const [k, v] of Object.entries(CRISES[W.CR.key].during)) W.m[k] *= v; W.OWN = computeOwn(A); return W; }
  const owner = (W, h) => W.OWN[h] && W.OWN[h].u;
  const hexesOf = (W, u) => Object.keys(W.OWN).filter(h => W.OWN[h].u === u).map(Number);
  const rankOf = xp => { let i = 0; for (let j = 0; j < RANKS.length; j++) if ((xp || 0) >= RANKS[j][0]) i = j; return i; };
  const rankName = n => RANKS[rankOf(n.xp)][1];
  const maxHex = n => !n ? 0 : (n.ai && n.ai.boss) ? Infinity : adminCap(n); // kept for older callers: now the administration capacity
  // fresh-start season worlds have no province limit (the server sets cfg.noAdmin while one runs); the real world always has one
  let NOADM = false;
  const adminCap = n => !n ? 0 : (n.ai && n.ai.boss) || NOADM ? Infinity : ADMIN.base + ADMIN.per * rankOf(n.xp || 0) + (n.ai ? ADMIN.ai : 0) + ADMIN.office.cap * (n.office || 0);
  // what one province costs to administer
  function provAdmin(W, u, h) { { const n0 = W.A[u]; if (n0 && n0.outposts && n0.outposts[h] && h != n0.cap) return 1; } const n = W.A[u], o = W.OWN[h]; if (!n || !o || o.u !== u || o.cap || +h === +n.cap) return 0; const core = (W.now - o.ts) / 864e5 >= ADMIN.coreD; return (core ? 1 : ADMIN.colony) + (P[n.cap] && kmBetween(+h, +n.cap) > ADMIN.farKm ? ADMIN.far : 0); }
  function adminState(W, u) { const n = W.A[u]; if (!n) return { cap: 0, used: 0, over: 0, prodF: 1 }; const cap = adminCap(n);
    if (!isFinite(cap)) return { cap, used: 0, over: 0, prodF: 1, core: 0, colony: 0, far: 0, severe: false };
    let used = 0, core = 0, colony = 0, far = 0; for (const h of hexesOf(W, u)) { const c = provAdmin(W, u, h); if (!c) continue; used += c; const o = W.OWN[h]; if ((W.now - o.ts) / 864e5 >= ADMIN.coreD) core++; else colony++; if (P[n.cap] && kmBetween(+h, +n.cap) > ADMIN.farKm) far++; }
    const over = Math.max(0, used - cap), O = ADMIN.over; return { cap, used, over, core, colony, far, prodF: 1 - Math.min(O.prodMax, over * O.prod), severe: used > cap * O.severe, cost: over ? Math.round(Math.min(Math.max(1e5, (n.gdp || 0) * O.cost) * over, Math.max(0, n.cash || 0) * O.costMax)) : 0, st: over ? Math.min(O.stMax, over * O.st) : 0, since: n.admSince || 0, rebelAt: n.admSince ? n.admSince + O.graceH * HOUR : 0 }; }
  const overPaused = W => W.now < ((W.cfg && W.cfg.overPause) || 0);
  const adminF = (W, u) => { const n = W.A[u]; return !n || overPaused(W) || (n.ai && n.ai.boss) ? 1 : adminState(W, u).prodF; };
  const officeCost = n => { const l = (n.office || 0) + 1, O = ADMIN.office; return { cash: Math.round(O.cash * Math.pow(l, 1.5)), steel: O.steel * l, goods: O.goods * l }; };
  const R = (W, a, b) => (W.A[a] && W.A[a].rel && W.A[a].rel[b]) || {};
  function atWar(W, a, b) { const x = R(W, a, b), y = R(W, b, a); const w = Math.max(x.war || 0, y.war || 0); if (!w) return false; return !((x.peace || 0) > w && (y.peace || 0) > w); }
  const warSince = (W, a, b) => Math.max(R(W, a, b).war || 0, R(W, b, a).war || 0);
  // a cancellation by either side ends the deal, and both sides must agree again afterwards
  function pact(W, a, b, k) { if (k === 'trade' && (rogue(W, W.A[a]) || rogue(W, W.A[b]))) return false; const x = R(W, a, b), y = R(W, b, a), un = Math.max(x['un' + k] || 0, y['un' + k] || 0); return (x[k] || 0) > un && (y[k] || 0) > un && !atWar(W, a, b); }
  function offered(W, a, b, k) { const x = R(W, a, b), y = R(W, b, a), un = Math.max(x['un' + k] || 0, y['un' + k] || 0); return (x[k] || 0) > un && !((y[k] || 0) > un); }
  const others = (W, u) => Object.keys(W.A).filter(v => v !== u);
  const wars = (W, u) => others(W, u).filter(v => atWar(W, u, v));
  const allies = (W, u) => others(W, u).filter(v => pact(W, u, v, 'ally'));
  const embargoed = (W, n) => (n.embargo || 0) > W.now;
  // World Council measures on one nation (each field holds the time it ends)
  const measure = (W, n, k) => !!n && (k === 'frozen' ? !!(n.frozen && n.frozen.until > W.now) : (n[k] || 0) > W.now);
  const ceasefireMsg = (W, a, b) => measure(W, a, 'ceasefire') || measure(W, b, 'ceasefire') ? `A World Council ceasefire is in force between ${a.name} and ${b.name} for another ${fmtT(Math.max(a.ceasefire || 0, b.ceasefire || 0) - W.now)}. No battles, strikes or launches until it ends.` : null;
  // trade partners: nations with a trade agreement, plus allies (allies trade automatically). Rogue states and embargoed nations trade with no one.
  const tradesWith = (W, u, v) => (pact(W, u, v, 'trade') || (sameBloc(W, u, v) && !rogue(W, W.A[u]) && !rogue(W, W.A[v])) || (pact(W, u, v, 'ally') && !rogue(W, W.A[u]) && !rogue(W, W.A[v]))) && !embargoed(W, W.A[v]);
  const traders = (W, u) => embargoed(W, W.A[u]) ? [] : others(W, u).filter(v => tradesWith(W, u, v));
  const blocOf = (W, u) => { const n = W.A[u], b = n && n.bloc && W.B[n.bloc]; return b && (b.members || []).includes(u) ? b : null; };
  const sameBloc = (W, u, v) => { const b = blocOf(W, u); return !!b && b.members.includes(v); };
  const tradeDeals = (W, u) => others(W, u).filter(v => pact(W, u, v, 'trade'));
  const sanctioned = n => (n.aggr || 0) >= 50;
  // rogue state ("the North Korea treatment"): 75+ aggression brings a full embargo and isolation for at least 24 hours
  const ROGUE_AT = 75, ROGUE_MIN = 12 * HOUR;
  const rogue = (W, n) => !!n && (n.rogue || 0) > (W ? W.now : Date.now());
  const oilF = n => ((n.res && n.res.oil) || 0) > 0 ? 1 : .6;
  const cheap = n => GOV[n.gov].cheap || 1;
  const moraleF = n => .75 + (n.morale == null ? 70 : n.morale) / 400;
  // diminishing returns: the first levels count fully, later ones less and less (stops one nation running away with the world)
  const soft = (x, s) => s * Math.log(1 + Math.max(0, x || 0) / s);
  // TECH GAP: a much more advanced nation is far harder to hurt. Strike and special-attack damage scales with the square root of the
  // attacker's tech (+10) over the target's (+10): tech 30 against tech 220 does about 42%, and a far more advanced attacker does up to 1.5x.
  // Ground battles use the square root of that again (tech 30 against 220 fights at about 65%).
  const gapF = (a, d) => !a || !d ? 1 : clamp(Math.sqrt(((a.tech || 0) + 10) / ((d.tech || 0) + 10)), .25, 1.5);
  const techF = n => (1 + soft(n.tech, 10) * .05) * (1 + n.train * .02);
  const devLvl = (n, h) => (n && n.dev && n.dev[h]) || 0;
  const devTotal = (W, u) => { const n = W.A[u]; if (!n || !n.dev) return 0; let t = 0; for (const h of Object.keys(n.dev)) if (W.OWN[h] && W.OWN[h].u === u) t += n.dev[h] || 0; return t; };
  const devCost = (W, u, lvl) => { const n = W.A[u], i = lvl - 1; return { cash: Math.round(Math.max(DEV.base, (n.gdp || 0) * DEV.gdpPct) * DEV.mult[i] / 1e5) * 1e5, steel: DEV.steel[i], goods: DEV.goods[i] }; };
  // a province changes hands: the new owner gets its development, one level lower (war and upheaval damage it)
  function xferDev(W, from, to, h, drop) { const a = W.A[from], b = W.A[to], l = devLvl(a, h); if (a && a.dev) delete a.dev[h]; if (b && l - (drop || 0) > 0) { b.dev = b.dev || {}; b.dev[h] = l - (drop || 0); } }
  // trade routes grow with age: a route counts once when new and up to twice after 7 days
  const routeStart = (W, u, v) => { if (pact(W, u, v, 'trade')) return Math.max(R(W, u, v).trade || 0, R(W, v, u).trade || 0); if (pact(W, u, v, 'ally')) return Math.max(R(W, u, v).ally || 0, R(W, v, u).ally || 0); return W.now; };
  const routeW = (W, u, v) => 1 + Math.min(1, Math.max(0, W.now - routeStart(W, u, v)) / (7 * 864e5));
  const tradeVal = (W, u) => { const n = W.A[u]; return traders(W, u).map(v => routeW(W, u, v)).sort((a, b) => b - a).slice(0, tcap(n)).reduce((s, x) => s + x, 0) * W.m.tradeMul; };
  const power = (W, u) => { const n = W.A[u]; return ((n.troops || 0) + (n.ships || 0) * 25 + (n.air || 0) * 20) * techF(n) * oilF(n) * GOV[n.gov].mil * moraleF(n); };
  const score = (W, u) => { const n = W.A[u]; return Math.round(hexesOf(W, u).length * 100 + (n.troops || 0) * .4 + (n.ships || 0) * 8 + (n.air || 0) * 6 + soft(n.tech, 10) * 60 + (n.xp || 0) * .1 + n.pop / 2000 + (n.gdp || 0) / 5e5 + devTotal(W, u) * DEV.score + (n.prestige || 0) * 50); };
  const isCoastal = h => !!(P[h] && P[h].co);
  const hasCoast = (W, u) => hexesOf(W, u).some(isCoastal);

  // ---------- economy ----------
  const budget = n => ({ ...DEFBUDGET, ...(n.budget || {}) });
  const debtRatio = n => (n.debt || 0) / Math.max(1, n.gdp || 1);
  function rating(W, n) { if ((n.defaulted || 0) > W.now - 48 * HOUR) return 'D'; const r = debtRatio(n); return r < .3 ? 'AAA' : r < .6 ? 'AA' : r < .9 ? 'A' : r < 1.2 ? 'BBB' : r < 1.5 ? 'BB' : r < 2 ? 'B' : 'CCC'; }
  function interestRate(W, n) { return 3 + Math.max(0, debtRatio(n) - .4) * 12 + ((n.defaulted || 0) > W.now - 48 * HOUR ? 10 : 0) + W.m.rate; }
  // combined effect of a nation's laws and wonders: multipliers (gdp, tax, research, xp, def, spend, oil) and additions (ap, st, unemp, health, edu, spread, tcap)
  const fxOf = n => { const o = []; for (const l of n.laws || []) if (LAWS[l]) o.push(LAWS[l]); for (const k of Object.keys(n.wonders || {})) if (WONDERS[k]) o.push(WONDERS[k].fx); const now = Date.now(); for (const b of n.boosts || []) if (b.until > now) o.push(b); const bl = n.bloc && BL[n.bloc]; if (bl) for (const k of Object.keys(bl.done || {})) if (BPROJ[k]) o.push(BPROJ[k].fx); return o; };
  const fxMul = (n, k) => { let v = 1; for (const f of fxOf(n)) if (f[k] != null) v *= f[k]; return v; };
  const fxAdd = (n, k) => { let v = 0; for (const f of fxOf(n)) if (f[k] != null) v += f[k]; return v; };
  const tcap = n => 5 + fxAdd(n, 'tcap');
  // nuclear effects: ground zero (taxes stop), fallout zone, worldwide nuclear winter
  const nuked = (W, n) => !!(n && n.nuked && n.nuked.until > W.now);
  const nukeF = (W, n, zero, fall, winter) => nuked(W, n) ? zero : (n.fallout || 0) > W.now ? fall : (n.winter || 0) > W.now ? winter : 1;
  function gdpTarget(W, u) {
    const n = W.A[u], b = budget(n);
    const pc = 187.5 * (1 + soft(n.tech, 10) * .04) * (1 + soft(n.infra, 10) * .05) * (.7 + (n.edu == null ? 50 : n.edu) / 100 * .6) * (.85 + (n.health == null ? 50 : n.health) / 100 * .3)
      * (1 + tradeVal(W, u) * .03) * (1 + soft(devTotal(W, u), 20) * DEV.gdp) * fxMul(n, 'gdp') * (1 - (n.unemp == null ? 6 : n.unemp) / 100) * (.8 + n.stability / 500) * (1 - Math.max(0, (n.infl || 0) - 5) / 100)
      * (sanctioned(n) ? .85 : 1) * (rogue(W, n) ? .85 : 1) * (radOn(W, n) ? .94 : 1) * nukeF(W, n, .6, .85, .95) * Math.pow(.96, wars(W, u).length) * ((n.defaulted || 0) > W.now - 48 * HOUR ? .85 : 1) * (.92 + (n.iq == null ? 50 : n.iq) / 100 * .16) * W.m.gdp;
    return n.pop * pc;
  }
  // development aid: nations far behind the world leader earn up to +50% tax revenue, shrinking as they catch up
  function devAid(W, u) {
    if (!W._top || W._top.t !== W.now || W._top.n !== Object.keys(W.A).length) { let t = 0; for (const x of Object.keys(W.A)) t = Math.max(t, score(W, x)); W._top = { t: W.now, n: Object.keys(W.A).length, v: t }; }
    const top = W._top.v, me = score(W, u); if (!top || me >= top * .3 || rogue(W, W.A[u])) return 0;
    return Math.round(.5 * (1 - me / (top * .3)) * 100) / 100;
  }
  function taxIncome(W, u) { const n = W.A[u], g = GOV[n.gov]; const trade = (1 + tradeVal(W, u) * .05 * (sanctioned(n) ? 0 : 1)) * (1 + rankOf(n.xp) * RANK_TAX) * adminF(W, u); return (n.gdp || gdpTarget(W, u)) * n.tax / 100 / 150 * (0.5 + n.approval / 100) * g.inc * trade * (1 + rankOf(n.xp) * .1) * W.cfg.income * W.m.tax * (1 + devAid(W, u)) * (rogue(W, n) ? .8 : 1) * nukeF(W, n, 0, .5, .85) * fxMul(n, 'tax'); }
  const spendPerTick = n => (n.gdp || 0) * budget(n).spend / 100 / TICKS_PER_YEAR * fxMul(n, 'spend');
  const overAt = n => maxHex(n);
  const bribeRecent = (n, now) => (n.bribes || []).filter(t => now - t < BRIBE.windowD * 864e5);
  const bribeNeeded = (W, n) => !!n && (rogue(W, n) || sanctioned(n) || ['embargo', 'armsEmb', 'condemned'].some(k => (n[k] || 0) > W.now) || !!(n.frozen && n.frozen.until > W.now));
  const bribePrice = (W, n) => Math.round(Math.max(BRIBE.min, (n.cash || 0) * BRIBE.pct) * (rogue(W, n) ? BRIBE.rogueX : 1) * Math.pow(2, bribeRecent(n, W.now).length) / 1e5) * 1e5;
  const overstretch = n => { const at = overAt(n), x = isFinite(at) ? Math.max(0, hexN(n) - at) : 0; return { at, extra: x, cost: x ? Math.round(Math.max(2e5, (n.gdp || 0) * OVER.cost) * x) : 0, st: x ? OVER.st : 0, since: n.overSince || 0, rebelAt: n.overSince ? n.overSince + OVER.graceH * HOUR : 0 }; };
  const inspectFee = n => Math.round(Math.min(INSPECT.cap, INSPECT.base + (n.gdp || 0) * INSPECT.pct) * (n.warhead ? INSPECT.warhead : 1));
  const radOn = (W, n) => !!(n && n.rad && n.rad.until > W.now);
  const upkeep = (W, n) => ((n.troops || 0) * 8 + (n.ships || 0) * 120 + (n.air || 0) * 150 + (n.nuke ? NUKE.upkeep : 0) + 0) * W.m.upkeep;
  function production(W, u) {
    const n = W.A[u]; const p = { food: 0, oil: 0, steel: 0, goods: 0, mun: 0 };
    for (const h of hexesOf(W, u)) {
      const pr = P[h];
      const q = { food: 0, oil: 0, steel: 0, goods: 0 }; let dk = 1 + DEV.prod * devLvl(n, h);
      if (h == n.cap) { for (const k in CAPP) q[k] += CAPP[k]; } else { const t = TYPE[pr.t] || TYPE.P; for (const k in t.p) q[k] += t.p[k]; }
      if (pr.r) q.food += 5; if (pr.m) q.steel += 4; if (pr.co) q.goods += 3;
      if ((W.DIS || []).some(x => x.h == h && x.until > W.now)) dk *= .3; // a disaster zone produces little until it recovers
      for (const k in q) p[k] += q[k] * dk;
    }
    const m = (1 + rankOf(n.xp) * .1) * (1 + soft(n.infra, 10) * .05) * W.cfg.income * adminF(W, u);
    const pf = fxMul(n, 'prod'); for (const k in p) p[k] = Math.round(p[k] * m * pf * (k === 'food' ? W.m.food * (radOn(W, n) && n.rad.acc ? NUKEACC.crops : 1) : k === 'oil' ? W.m.oil : 1));
    return p;
  }
  const consumption = n => ({ food: Math.round(n.pop / 1000 * .25), oil: Math.round(((n.troops || 0) / 100 * .5 + (n.ships || 0) * .5 + (n.air || 0) * .4 + n.infra * .5) * fxMul(n, 'oil')), steel: 0, goods: Math.round(n.pop / 1000 * .05), mun: 0 });
  const popCap = (W, u) => (hexesOf(W, u).length * 150000 + devTotal(W, u) * DEV.pop) * (1 + soft(W.A[u].infra, 10) * .05);
  // World market. Prices follow the last 6 hours of net trading by all nations, but each nation's own net counts for at most
  // a share of the market depth, so no single nation can push a price beyond about ×2.1 or ×0.47. Big orders pay the price along the way
  // (not the price before the order), so buying and immediately selling back always loses the market fee.
  // market depth grows with the world: more land held means bigger stockpiles and a deeper market
  const mktK = W => 4000 + 120 * Object.keys(W.OWN || {}).length, mktMult = (W, net) => clamp(Math.exp(net / mktK(W)), .4, 3);
  function mktNets(W, r, skip) { let other = 0, mine = 0; const since = W.now - 6 * HOUR;
    const cap = mktK(W) * .75; for (const [u, n] of Object.entries(W.A)) { let v = 0; for (const t of n.trades || []) if (t.t > since && t.r === r) v += t.q; v = clamp(v, -cap, cap); if (u === skip) mine = v; else other += v; }
    return { other, mine }; }
  function prices(W) { const p = {}; for (const k in RES) { const { other } = mktNets(W, k, null); p[k] = Math.round(RES[k].p * mktMult(W, other) * (W.m.price[k] || 1)); } return p; }
  // average price multiplier for an order of q units (+ buy, − sell) by nation u, integrated along the price path
  function orderMult(W, u, r, q) { const { other, mine } = mktNets(W, r, u), cap = mktK(W) * .75, N = 60; let sum = 0;
    for (let i = 0; i < N; i++) sum += mktMult(W, other + clamp(mine + q * (i + .5) / N, -cap, cap)); return sum / N; }
  // price multiplier at the very end of an order of q units, relative to the price before it (for "sensible max" buttons)
  function orderEdge(W, u, r, q) { const { other, mine } = mktNets(W, r, u), cap = mktK(W) * .75; return mktMult(W, other + clamp(mine + q, -cap, cap)) / mktMult(W, other + mine); }
  function spreads(W, u) { const n = W.A[u]; const sp = sanctioned(n) ? .3 : 0, tb = Math.min(tcap(n), traders(W, u).length) * .03 * (sanctioned(n) ? 0 : 1) * W.m.tradeMul; const inf = Math.max(0, (n.infl || 0) - 3) / 200; const lx = fxAdd(n, 'spread'); return { buy: 1.08 + sp - tb - W.m.spread + inf - lx, sell: .92 - sp + tb + W.m.spread + lx }; }
  const maxBorrow = n => Math.max(0, (n.gdp || 0) * 1.2 - (n.debt || 0));

  // ---------- costs ----------
  const troopCap = n => Math.floor((n.pop || 0) * ((n.laws || []).includes('conscription') ? .06 : .04));
  const recruitBatch = n => Math.round(Math.max(20, Math.round(40 + soft(n.pop * .0012, 600))) * ((n.laws || []).includes('conscription') ? 1.5 : 1)); // bigger nations recruit more, with diminishing returns
  const hexN = n => Object.keys(n.hexes || {}).length;
  const navyBatch = n => 2 + Math.floor(rankOf(n.xp) / 2) + Math.floor(hexN(n) / 6);
  const airBatch = n => 3 + Math.floor(rankOf(n.xp) / 2) + Math.floor(hexN(n) / 5);
  const spyCap = n => 5 + rankOf(n.xp) * 3;
  const expandCost = (W, u) => Math.round(8e4 * Math.pow(Math.max(1, hexesOf(W, u).length), 1.35));
  const topTech = W => { let t = 0; for (const x of Object.values(W.A)) t = Math.max(t, x.tech || 0); return t; };
  const catchUp = (W, n) => { if (rogue(W, n)) return 1.5; const top = topTech(W); return n.tech < top ? .5 + .5 * (n.tech + 1) / (top + 1) : 1; }; // rogue states face a technology blockade // known technology is cheaper to copy
  const researchCost = (W, n) => Math.round(5e4 * Math.pow(n.tech + 1, 1.6) * (GOV[n.gov].res > 1 ? .85 : 1) * W.m.research * catchUp(W, n) * fxMul(n, 'research'));
  const maxTrain = n => 10 + rankOf(n.xp) * 5;
  const infraCost = n => Math.round(6e4 * Math.pow(n.infra + 1, 1.5) * cheap(n));
  const fortCost = n => Math.round(1e5 * Math.pow(n.fort + 1, 1.5) * cheap(n));
  const rallyCost = n => Math.round(2e4 + n.pop * .05);
  const campaignCost = n => Math.round(5e4 + n.pop * .1);
  const streakMult = c => c % 7 === 0 ? 2.5 : 1 + .15 * (Math.min(c, 6) - 1); // grows to ×1.75, with a ×2.5 bonus every 7th day
  const dailyGrant = n => 2e5 * (1 + rankOf(n.xp) * .5);
  const left = (W, n, k) => Math.max(0, ((n.cd && n.cd[k]) || 0) - W.now);

  // ---------- territory ----------
  // settling: bordering land (or across a narrow sea with warships) at the normal price; anywhere else costs 1.5x plus 1x per 2,500 km
  function settleCost(W, u, h) { const base = expandCost(W, u); if (expandTargets(W, u).includes(h)) return { cash: base, far: false, km: 0 };
    let km = Infinity; for (const k of hexesOf(W, u)) km = Math.min(km, kmBetween(k, h)); km = isFinite(km) ? Math.round(km) : 0; const x = 2 + km / 1000; /* far-away land is very expensive */ return { cash: Math.round(base * x), far: true, km, x }; }
  function expandTargets(W, u) { const n = W.A[u], ships = (n && n.ships) || 0; const t = new Set(); for (const h of hexesOf(W, u)) { for (const k of land(h)) if (!W.OWN[k]) t.add(k); if (ships > 0 && isCoastal(h)) for (const k of sea(h)) if (!W.OWN[k]) t.add(k); } return [...t]; }
  // where a new nation may start: unclaimed land at least 2 provinces from any nation. When the map fills up, the rule relaxes
  // (1 province away, then any unclaimed land), and when every province is taken the AI nation with the most land gives up an outer
  // province, so a new player can always join.
  function startClear(W, h, dist) { if (!P[h] || W.OWN[h]) return false; if (!dist) return true; const seen = new Set([h]); let fr = [h]; for (let d = 0; d < dist; d++) { const nx = []; for (const x of fr) for (const k of nbrs(x)) if (!seen.has(k)) { seen.add(k); nx.push(k); } fr = nx; } for (const k of seen) if (W.OWN[k]) return false; return true; }
  const startStrict = (W, h) => startClear(W, h, 2);
  function startDist(W) { if (W._sd != null && W._sdOwn === W.OWN) return W._sd; let sd = -1; for (const dist of [2, 1, 0]) { if (P.some((p, h) => startClear(W, h, dist))) { sd = dist; break; } } W._sd = sd; W._sdOwn = W.OWN; return sd; }
  function cedeDonor(W) { let best = null, bx = 0; for (const [u, n] of Object.entries(W.A)) { if (n.ai && n.ai.boss) continue; const x = hexesOf(W, u).length - maxHex(n); if (x > bx) { bx = x; best = u; } } if (best) return best; let bn = 2; for (const [u, n] of Object.entries(W.A)) { if (!n.ai || n.ai.boss) continue; const c = hexesOf(W, u).length; if (c > bn) { bn = c; best = u; } } return best; }
  function startOk(W, h) { const sd = startDist(W); if (sd >= 0) return startClear(W, h, sd); const d = cedeDonor(W); if (!d || !P[h]) return false; const o = W.OWN[h]; return !!o && o.u === d && +h !== +W.A[d].cap; }
  // land you've held a long time and invested in is much harder to take: +5% per day held (up to +100% after 20 days), +15% per development level
  const holdF = (W, n, h) => (1 + Math.min(1, hexAge(W, h) * .05)) * (1 + devLvl(n, h) * .15);
  function hexAge(W, h) { const o = W.OWN[h]; if (!o) return 0; const ts = o.cap ? W.A[o.u].created : o.ts; return (W.now - ts) / (24 * HOUR); }
  // ---------- reach: any enemy province can be attacked; distance makes it weaker and costlier ----------
  // landmasses: provinces joined by land borders. Same landmass = the army can march there; another one = it must go by ship.
  const COMP = (() => { const c = new Array(P.length).fill(-1); let id = 0; for (let i = 0; i < P.length; i++) { if (c[i] >= 0) continue; const st = [i]; c[i] = id; while (st.length) { const x = st.pop(); for (const y of land(x)) if (c[y] < 0) { c[y] = id; st.push(y); } } id++; } return c; })();
  const kmBetween = (a, b) => { const r = Math.PI / 180, A = P[a].c, B = P[b].c; const s2 = Math.sin((B[1] - A[1]) * r / 2) ** 2 + Math.cos(A[1] * r) * Math.cos(B[1] * r) * Math.sin((B[0] - A[0]) * r / 2) ** 2; return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s2))); };
  function reach(W, u, h) {
    const mine = hexesOf(W, u); if (!mine.length) return null;
    if (land(h).some(k => owner(W, k) === u)) return { rt: 'land', km: 0 };
    if (sea(h).some(k => owner(W, k) === u && isCoastal(k))) return { rt: 'sea', km: 0 };
    let km = Infinity, same = false; for (const k of mine) { km = Math.min(km, kmBetween(k, h)); if (COMP[k] === COMP[h]) same = true; }
    const n_ = W.A[u], st = n_ && n_.outposts ? Object.keys(n_.outposts).some(o => owner(W, +o) === u && kmBetween(+o, h) <= OUTPOST.stageKm) : false; // staged from an outpost: no distance penalty
    return { rt: same ? 'march' : 'ocean', km: st ? 0 : Math.round(km), staged: st || undefined };
  }
  // airborne invasions: when the only way in is by sea and the fleet can't do it (no warships, or no coast), aircraft can fly troops in instead
  const AIRBORNE = { tech: 4, min: 20, per: 10, str: .6, costX: 1.6 };
  const navalOk = (W, u, rt) => { const me = W.A[u]; return rt === 'sea' ? (me.ships || 0) > 0 : rt === 'ocean' ? hasCoast(W, u) && (me.ships || 0) >= 5 : true; };
  const airborneOk = n => (n.tech || 0) >= AIRBORNE.tech && (n.air || 0) >= AIRBORNE.min;
  function reachBy(W, u, h) { const r = reach(W, u, h); if (!r || r.rt === 'land' || r.rt === 'march' || navalOk(W, u, r.rt) || !airborneOk(W.A[u])) return r; return { rt: 'air', km: r.km, via: r.rt, staged: r.staged }; }
  function route(W, u, h) { const r = reachBy(W, u, h); return r ? r.rt : null; }
  // strength and cost by route: borders fight at full strength; distant fronts lose up to 45% and cost more to supply
  const distF = km => Math.max(.55, 1 - km / 12000);
  const logiCut = n => { const g = n && bestGen(n, 'logistics'); return g ? 1 - g.stars * .1 : 1; };
  const routeMult = (r, n) => r.rt === 'air' ? AIRBORNE.str * distF(r.km) : r.rt === 'land' ? 1 : r.rt === 'sea' ? .8 : 1 - (1 - (r.rt === 'march' ? distF(r.km) : .8 * distF(r.km))) * logiCut(n);
  const routeCostX = (r, n) => r.rt === 'air' ? AIRBORNE.costX + r.km / 2500 * logiCut(n) : r.rt === 'land' || r.rt === 'sea' ? 1 : 1 + r.km / 2500 * logiCut(n);
  const PER_SHIP = { sea: 100, ocean: 75 };
  const fmtT = ms => { const s = Math.ceil(ms / 1e3); if (s >= 3600) return Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm'; return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function canAttack(W, u, h) {
    const me = W.A[u]; if (!me) return 'Found a nation first.'; if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    const v = owner(W, h); if (!v || v === u) return 'Not a foreign province.'; const n = W.A[v];
    if (n.overlord === u || me.overlord === v) return n.overlord === u ? `${n.name} is your vassal. Release it first to fight it.` : `You are ${n.name}'s vassal. Declare independence first.`;
    if (rankOf(me.xp) < 2) return `You must reach the rank of Mayor (300 XP) to wage war. You have ${num(me.xp)} XP.`;
    if (!atWar(W, u, v)) return `You are not at war with ${n.name}. Declare war first.`;
    { const cf = ceasefireMsg(W, me, n); if (cf) return cf; }
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    const theyHitMe = hitRecently(W, u, v);
    // AI nations get none of the protections meant for real players
    if (!theyHitMe && !n.ai && W.now - n.created < W.cfg.protectH * HOUR && !(n.out || []).some(e => e.type === 'battle')) return `${n.name} is under new-nation protection.`;
    if (shieldOn(W, n)) return `${n.name} is rebuilding under international protection for another ${fmtT(n.shield - W.now)}.`;
    const fairWar = (R(W, u, v).fair || 0) === 1;
    if (W.cfg.weakRule && !theyHitMe && !fairWar && !n.ai && score(W, v) < score(W, u) * .4) return `${n.name} is far weaker than you. Attacking them is not permitted.`;
    if (W.OWN[h].cap) {
      if (!W.cfg.conquest) return 'Capitals cannot be captured.';
      if (n.nuke && !rogue(W, n)) return `${n.name} has a nuclear deterrent. Its capital cannot be besieged unless it becomes a rogue state.`;
      if (Object.keys(n.hexes || {}).length > 1) return `The capital can only be besieged once ${n.name} has lost all its other provinces.`;
      // the defender always gets a warning period: from losing its last other province, or from the declaration of war (none for AI)
      const start = n.ai ? 1 : n.lastStand || warSince(W, u, v);
      const ls = start + (W.cfg.lastStandH ?? 24) * HOUR;
      if (W.now < ls) return `${n.name} is making its last stand. The capital can be besieged in ${fmtT(ls - W.now)}.`;
    }
    const r = reachBy(W, u, h); if (!r) return 'Found a nation first.';
    const orAir = ` Or fly troops in: an airborne invasion needs tech level ${AIRBORNE.tech} and at least ${AIRBORNE.min} aircraft (each carries ${AIRBORNE.per} troops).`;
    if (r.rt === 'sea' && !(me.ships > 0)) return 'This province is across the sea. Build warships to carry your troops.' + orAir;
    if (r.rt === 'ocean' && !hasCoast(W, u)) return 'This province is overseas. You need a coastal province and warships to reach it.' + orAir;
    if (r.rt === 'ocean' && (me.ships || 0) < 5) return `This province is overseas. You need at least 5 warships to carry an invasion (75 troops each). You have ${me.ships || 0}.` + orAir;
    if (left(W, me, 'attack')) return `Your forces are regrouping: ${fmtT(left(W, me, 'attack'))}.`;
    return null;
  }
  // everything a player needs to judge an attack, computed the same way the battle is
  function attackPlan(W, u, h, X, AIR) {
    const me = W.A[u], v = owner(W, h), d = v && W.A[v]; if (!me || !d) return null;
    const r = reachBy(W, u, h); if (!r) return null;
    const SEA = r.rt === 'sea' || r.rt === 'ocean', AIRB = r.rt === 'air', perShip = PER_SHIP[r.rt] || 0;
    const maxX = Math.max(0, SEA ? Math.min(me.troops, (me.ships || 0) * perShip) : AIRB ? Math.min(me.troops, (me.air || 0) * AIRBORNE.per) : me.troops);
    X = X == null ? Math.floor(maxX * .8) : Math.max(0, Math.min(maxX, Math.floor(X))); AIR = AIR == null ? Math.floor((me.air || 0) * .8) : Math.max(0, Math.min(me.air || 0, Math.floor(AIR)));
    if (AIRB) { AIR = Math.max(AIR, Math.min(me.air || 0, Math.ceil(X / AIRBORNE.per))); X = Math.min(X, AIR * AIRBORNE.per); } // the aircraft carry the troops
    const mult = routeMult(r, me), cx = routeCostX(r, me), base = atkCost(W, X);
    const cost = { cash: Math.round(base.cash * cx), oil: Math.ceil(base.oil * cx) + AIR * 2, food: Math.ceil(base.food * cx) };
    const atk = (X + AIR * 20) * atkMult(me) * mult * (rogue(W, d) ? 1.15 : 1) * Math.sqrt(gapF(me, d)), def = defense(W, h, u);
    // chance: average over the battle's random spread (attack ±15%, defense ±10%), times the chance of winning at sea first
    const grid = (a, b, sa, sb) => { let w = 0; for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) if (a * (1 - sa + 2 * sa * (i + .5) / 20) > b * (1 - sb + 2 * sb * (j + .5) / 20)) w++; return w / 400; };
    let chance = def > 0 ? grid(atk, def, .15, .1) : 1;
    if (SEA && d.ships > 0) chance *= grid((me.ships || 0) * 25 * techF(me), navalDefense(W, h), .15, .1);
    if (AIRB && d.air > 0) chance *= 1 - Math.min(.5, d.air / (d.air + AIR * 1.5) * .25); // some transports may be shot down
    return { rt: r.rt, km: r.km, via: r.via, staged: r.staged, mult, costX: cx, X, AIR, maxX, perShip: AIRB ? AIRBORNE.per : perShip, cost, atk: Math.round(atk), def: Math.round(def), chance, regroupMin: r.rt === 'ocean' || AIRB ? 60 : r.rt === 'march' ? 45 : 30 };
  }
  const terrainF = (h, rt) => (P[h].m ? 1.25 : 1) * (P[h].r && rt === 'land' ? 1.15 : 1);
  const outpostDef = (W, n, h) => { const o = n && n.outposts; if (!o) return 1; if (o[h]) return OUTPOST.def; return land(h).some(k => o[k] && owner(W, k) === owner(W, h)) ? OUTPOST.def : 1; };
  function defense(W, h, attacker) {
    const v = owner(W, h), n = W.A[v]; let t = (n.troops || 0) * .5 + (n.air || 0) * .5 * 20; for (const a of allies(W, v)) if (a !== attacker) t += (W.A[a].troops || 0) * .1;
    const rt = attacker ? route(W, attacker, h) : 'land';
    return t * techF(n) * (1 + soft(n.fort, 8) * .1) * (1 + rankOf(n.xp) * .08) * holdF(W, n, h) * oilF(n) * GOV[n.gov].mil * moraleF(n) * terrainF(h, rt) * ((n.regroup || 0) > W.now ? .75 : 1) * (W.OWN[h] && W.OWN[h].cap ? ((n.capMoved || 0) + CAPMOVE.fortH * HOUR > W.now ? 1.15 : 1.5) : 1) * genF(n, 'defense') * fxMul(n, 'def') * outpostDef(W, n, h) * (measure(W, n, 'guarantee') ? 1.2 : 1) * ((n.ai && n.ai.boss && n.ai.defX) || 1);
  }
  const navalDefense = (W, h) => { const v = owner(W, h), n = W.A[v]; return (n.ships || 0) * 25 * techF(n) * 1.2; };
  const bestGen = (n, type) => (n.gens || []).filter(g => g.type === type).reduce((b, g) => !b || g.stars > b.stars ? g : b, null);
  const genF = (n, type) => { const g = bestGen(n, type); return g ? 1 + g.stars * .04 : 1; };
  const atkMult = n => techF(n) * oilF(n) * GOV[n.gov].mil * moraleF(n) * genF(n, 'attack') * ((n.ai && n.ai.boss && n.ai.atkX) || 1); // atkX/defX: the admins' Rising Power difficulty
  function newGeneral(W, u, rng) {
    const n = W.A[u]; n.gens = n.gens || []; if (n.gens.length >= 3) return null;
    const r = rng(), type = r < .4 ? 'attack' : r < .7 ? 'defense' : 'logistics';
    const g = { id: rid(), name: GEN_FIRST[Math.floor(rng() * GEN_FIRST.length)] + ' ' + GEN_LAST[Math.floor(rng() * GEN_LAST.length)], type, stars: 1, wins: 0, t: W.now };
    n.gens.push(g); return g;
  }
  const atkCost = (W, x) => ({ cash: Math.round(x * 25 * W.m.atkCost), oil: Math.ceil(x / 10), food: Math.ceil(x / 20) });

  // ---------- decisions: situational conditions ----------
  const COND = {
    war: (W, u) => wars(W, u).length > 0, peace: (W, u) => !wars(W, u).length,
    dem: (W, u, n) => n.gov === 'dem', dic: (W, u, n) => n.gov === 'dic', mon: (W, u, n) => n.gov === 'mon', com: (W, u, n) => n.gov === 'com', notdem: (W, u, n) => n.gov !== 'dem',
    lowAp: (W, u, n) => n.approval < 40, highAp: (W, u, n) => n.approval > 70, lowSt: (W, u, n) => n.stability < 40, highTax: (W, u, n) => n.tax > 30, lowTax: (W, u, n) => n.tax < 15,
    rich: (W, u, n) => n.cash > 5e6, poor: (W, u, n) => n.cash < 3e5 || debtRatio(n) > 1, big: (W, u) => hexesOf(W, u).length >= 6, small: (W, u) => hexesOf(W, u).length <= 3,
    army: (W, u, n) => n.troops > 1500, sanctioned: (W, u, n) => sanctioned(n), allied: (W, u) => allies(W, u).length > 0, trader: (W, u) => traders(W, u).length > 0,
    lowFood: (W, u, n) => n.res.food < 150, oilRich: (W, u, n) => n.res.oil > 600, tech: (W, u, n) => n.tech >= 5, rank3: (W, u, n) => rankOf(n.xp) >= 3,
    neighbors: (W, u) => hexesOf(W, u).some(h => nbrs(h).some(k => owner(W, k) && owner(W, k) !== u))
  };
  const condOk = (W, u, c) => !c || c.split(' ').every(k => COND[k] ? COND[k](W, u, W.A[u]) : true);

  // ---------- mutation helpers (server only) ----------
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function log(n, t, W) { n.log = [{ t: W ? W.now : Date.now(), x: t }, ...(n.log || [])].slice(0, 60); }
  function pushOut(W, u, e) { const n = W.A[u]; e.id = rid(); e.t = W.now; n.out = [e, ...(n.out || [])].slice(0, 80); }
  function news(W, u, t) { pushOut(W, u, { type: 'news', x: t }); log(W.A[u], t, W); W.news.push(t); }
  const note = (W, u, kind, text) => { if (W.A[u]) W.notes.push({ u, kind, text }); };
  // how much aggression an attack adds, by target: real players x4/3, AI nations x1/3, the Rising Power 0
  // fighting AI nations alone never gets you sanctioned: hits on an AI nation can't push aggression past 34 (the Council's first threshold is 35)
  const AI_AGGR_CAP = 34, addAggr = (W, me, v, x) => { const d = W.A[v]; if (!(x > 0)) return me.aggr || 0; const a = me.aggr || 0; return Math.min(100, d && d.ai ? Math.max(a, Math.min(AI_AGGR_CAP, a + x)) : a + x); };
  const aggrScale = (W, v) => { const d = W.A[v]; return !d ? 1 : d.ai ? (d.ai.boss ? 0 : 1 / 3) : 4 / 3; };
  const aggrHit = (W, u, v, how) => { (W.hits = W.hits || []).push({ u, v, how }); const d = W.A[v]; if (d) { d.hitBy = d.hitBy || {}; d.hitBy[u] = W.now; } };
  // did v hit u (any battle, air or missile strike, or nuke) in the last 24 hours?
  const hitRecently = (W, u, v) => { const n = W.A[u], a = W.A[v]; if (!n || !a) return false; return (n.hitBy && W.now - (n.hitBy[v] || 0) < 24 * HOUR) || (a.out || []).some(e => e.type === 'battle' && e.to === u && W.now - e.t < 24 * HOUR); };
  // fighting back is not aggression: u is defending against v if v started this war on u, joined it against u's pact, or v hit u or one of u's allies in the last day
  function defending(W, u, v) {
    if (W.A[u] && W.A[u].cb && (W.A[u].cb[v] || 0) > W.now) return true; // caught their spies: a just cause for 24 hours
    const mine = R(W, u, v), theirs = R(W, v, u), since = warSince(W, u, v);
    if (mine.def) return true;
    for (const a of allies(W, u)) if (hitRecently(W, a, v)) return true;
    if (since && (mine.war || 0) === since && (mine.war || 0) > (theirs.war || 0)) return false; // you started this war: you stay the aggressor
    return (since && (theirs.war || 0) === since) || hitRecently(W, u, v);
  }
  // XP for repeatable actions with no cooldown (trades, donations): only once per window per kind, so spamming tiny amounts can't buy rank
  const xpOnce = (W, u, key, ms, x) => { const n = W.A[u]; if (!n) return; n.xpT = n.xpT || {}; if (n.xpT[key] > W.now - ms) return; for (const k in n.xpT) if (n.xpT[k] <= W.now - 6 * HOUR) delete n.xpT[k]; n.xpT[key] = W.now; gainXP(W, u, x); };
  function gainXP(W, u, x) { const n = W.A[u]; const b = rankOf(n.xp); n.xp = (n.xp || 0) + Math.round(x * W.cfg.xp * fxMul(n, 'xp')); const a = rankOf(n.xp);
    if (a > b) { let cash = 0; if (!n.ai) { for (let r = b + 1; r <= a; r++) cash += promoCash(r); n.cash += cash; n.approval = clamp(n.approval + 5, 0, 100); n.stability = clamp(n.stability + 5, 0, 100); }
      news(W, u, `${n.name} has risen to the rank of ${RANKS[a][1]}.`); W.promoted = RANKS[a][1]; note(W, u, 'rank', `You have been promoted to ${RANKS[a][1]}.${cash ? ` Promotion reward: ${money(cash)}, approval +5, stability +5.` : ''}`); } }
  // an achievement is earned once and pays XP and cash
  function achGrant(W, u, k) { const n = W.A[u]; if (!n || !ACH[k]) return false; n.ach = n.ach || {}; if (n.ach[k]) return false; n.ach[k] = W.now; const t = ACH_TIER[k] || 1, xp = ACH_XP[t - 1], cash = n.ai ? 0 : Math.round(Math.max(2e6, (n.gdp || 0) * .02) * t / 1e5) * 1e5;
    n.cash += cash; note(W, u, 'rank', `🏅 Achievement unlocked: ${ACH[k][0]}! Reward: +${xp} XP${cash ? ` and ${money(cash)}` : ''}.`); log(n, `Achievement unlocked: ${ACH[k][0]} (+${xp} XP${cash ? `, ${money(cash)}` : ''}).`, W); gainXP(W, u, xp); touch(W, u); return true; }
  const touch = (W, ...us) => us.forEach(u => W.changed.add(u));
  // a nation is conquered: remove it and every reference to it; the server deletes the document and tells the player
  function fallNation(W, v, info) {
    const d = W.A[v]; if (!d) return;
    delete W.A[v]; W.changed.delete(v);
    for (const [u, n] of Object.entries(W.A)) if (n.rel && n.rel[v]) { delete n.rel[v]; W.changed.add(u); }
    W.OWN = computeOwn(W.A); W.fallen.push({ id: v, t: W.now, ...info });
  }
  function setRel(n, v, k, t) { n.rel = n.rel || {}; n.rel[v] = { ...(n.rel[v] || {}), [k]: t }; }

  function normalize(n) {
    for (const k of ['cards', 'log', 'out', 'trades', 'seen', 'gdpHist']) if (!Array.isArray(n[k])) n[k] = [];
    for (const k of ['cd', 'hexes', 'rel', 'cnt']) if (!n[k] || typeof n[k] !== 'object') n[k] = {};
    for (const k of ['fort', 'train', 'infra', 'tech']) if (!Number.isFinite(n[k])) n[k] = 0;
    n.res = { food: 0, oil: 0, steel: 0, goods: 0, mun: 0, ...(n.res || {}) }; if (!n.munInit) { n.res.mun = Math.max(n.res.mun || 0, MUN.start); n.munInit = 1; } n.budget = budget(n);
    for (const [k, v] of [['ships', 0], ['air', 0], ['spies', 0], ['debt', 0], ['unemp', 6], ['infl', 2], ['health', 50], ['edu', 50], ['iq', 50], ['morale', 70]]) if (typeof n[k] !== 'number' || !isFinite(n[k])) n[k] = v;
    return n;
  }

  // a newcomer boxed in by big empires gets up to 2 neighbouring provinces from empires that are over their administration capacity
  function starterRoom(W, u) {
    const n = W.A[u]; if (!n) return 0; const free = land(n.cap).filter(k => !W.OWN[k]).length; let need = Math.max(0, 2 - free), got = 0; if (!need) return 0;
    const cand = land(n.cap).map(k => [k, W.OWN[k]]).filter(([k, o]) => o && !o.cap && o.u !== u && W.A[o.u] && !(W.A[o.u].ai && W.A[o.u].ai.boss) && adminState(W, o.u).over > 0)
      .sort((x, y) => (devLvl(W.A[x[1].u], x[0]) - devLvl(W.A[y[1].u], y[0])) || (adminState(W, y[1].u).over - adminState(W, x[1].u).over));
    for (const [k, o] of cand) { if (got >= need) break; const d = W.A[o.u]; delete d.hexes[k]; delete d.hexes[String(k)]; if (d.dev) delete d.dev[k]; if (d.conq) delete d.conq[k]; n.hexes[k] = W.now; got++;
      log(d, `${pname(k)} was handed to the newly founded ${n.name}: your empire was over its administration capacity, so this costs you nothing.`, W); note(W, o.u, 'diplo', `${pname(k)} was handed to the new nation ${n.name}. Your empire was over its administration capacity, so you lose no output.`); touch(W, o.u); }
    if (got) { W.OWN = computeOwn(W.A); log(n, `Neighbouring empires handed you ${got} province${got > 1 ? 's' : ''} so you have room to grow.`, W); } return got;
  }
  function found(W, u, o) {
    if (W.A[u]) fail('You already lead a nation.');
    if (typeof o.name !== 'string') fail('Choose a name for your nation.');
    const name = o.name.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(name)) fail('Choose a name of 2–28 letters, numbers and basic punctuation.');
    if (Object.values(W.A).some(n => n.name.toLowerCase() === name.toLowerCase())) fail('That name is already in use.');
    const color = COLORS.includes(o.color) ? o.color : COLORS[0];
    const gov = has(GOV, o.gov) ? o.gov : 'dem';
    const sd = startDist(W), h = Number(o.hex); if (!Number.isInteger(h) || !startOk(W, h)) fail(sd === 2 ? 'Select an unclaimed province at least two provinces away from any nation.' : sd === 1 ? 'The map is filling up: choose unclaimed land that does not border another nation.' : sd === 0 ? 'Choose any unclaimed province.' : 'Every province is taken: tap “Pick a good spot for me” to receive land ceded by an AI nation.');
    if (sd < 0) { const d = W.OWN[h].u, dn = W.A[d]; delete dn.hexes[h]; delete dn.hexes[String(h)]; log(dn, `${pname(h)} was ceded to a newly founded nation.`, W); touch(W, d); W.OWN = computeOwn(W.A); }
    const now = W.now;
    const n = W.A[u] = normalize({ v: 4, name, color, gov, created: now, cap: h, hexes: {}, xp: 0, cash: 1e6, pop: 1e5, troops: 300, ships: isCoastal(h) ? 2 : 0, air: 0, spies: 0, tech: 0, train: 0, infra: 0, fort: 0, tax: 20, approval: 60, stability: 60, aggr: 0,
      res: { food: 400, oil: 150, steel: 150, goods: 80 }, cd: {}, cnt: {}, lastTick: now, nextCard: now + 5 * MIN, cards: [], seen: [], log: [], out: [], rel: {}, trades: [], exp: 0, imp: 0,
      budget: { ...DEFBUDGET }, debt: 0, unemp: 6, infl: 2, health: 50, edu: 50, iq: 50, morale: 70, nextElection: gov === 'dem' ? now + W.cfg.electionH * HOUR : 0 });
    W.OWN = computeOwn(W.A); starterRoom(W, u); n.gdp = gdpTarget(W, u); n.gdpHist = [{ t: now, v: n.gdp }];
    news(W, u, `A new nation has been founded: ${name}, in ${pname(h)}.`); touch(W, u);
    W.welcome = `Welcome ${name}, a new nation founded in ${pname(h)}.`;
    return { msg: 'Your nation has been founded.' };
  }

  // would this operation succeed right now? Runs it on a throwaway copy of the nation and world and returns the reason it would fail ('' = it would work)
  function actCheck(W, u, k) { const n = W.A[u]; if (!n) return 'Found a nation first.';
    const n2 = JSON.parse(JSON.stringify(n)), W2 = Object.assign({}, W, { A: Object.assign({}, W.A, { [u]: n2 }), OWN: Object.assign({}, W.OWN), changed: new Set(), news: [], notes: [] });
    try { act(W2, u, k, undefined, () => .5); return ''; } catch (e) { return e && e.user ? e.message : ''; } }
  function act(W, u, k, arg, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const a = ACTS.find(x => x.k === k); if (!a) fail('Unknown operation.');
    if (left(W, n, k)) fail(`${a.n} is available in ${fmtT(left(W, n, k))}.`);
    let msg = '';
    if (k === 'tax') { const v = taxIncome(W, u); n.cash += v; n.rev = (n.rev || 0) + v; if (n.tax > 20) n.approval = clamp(n.approval - (n.tax - 20) * .1, 0, 100); msg = `Collected ${money(v)} in taxes.`; }
    else if (k === 'prod') { const p = production(W, u); for (const r in p) n.res[r] += p[r] * 2; msg = 'Production boosted: ' + Object.entries(p).filter(e => e[1]).map(([r, v]) => `+${v * 2} ${r}`).join(', ') + '.'; }
    else if (k === 'recruit') { const b = recruitBatch(n), c = b * 150 * cheap(n) * (measure(W, n, 'armsEmb') ? 2 : 1), s = Math.ceil(b / 10); if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); if (n.troops + b > troopCap(n)) fail(`Your population cannot support more soldiers (limit: 4% of population, ${num(troopCap(n))}).`); n.cash -= c; n.res.steel -= s; n.troops += b; n.approval = clamp(n.approval - .3, 0, 100); msg = `${num(b)} soldiers enlisted.`; }
    else if (k === 'navy') { if (measure(W, n, 'armsEmb')) fail('A World Council arms embargo is in force: you cannot build warships until it ends.'); if (!hasCoast(W, u)) fail('You need a coastal province to build warships.'); const b = navyBatch(n), c = Math.round(b * 6e4 * cheap(n)), s = b * 30, o = b * 10; if (n.cash < c || n.res.steel < s || n.res.oil < o) fail(`Requires ${money(c)}, ${s} steel and ${o} oil.`); n.cash -= c; n.res.steel -= s; n.res.oil -= o; n.ships += b; msg = `${b} warships commissioned.`; }
    else if (k === 'air') { if (measure(W, n, 'armsEmb')) fail('A World Council arms embargo is in force: you cannot build aircraft until it ends.'); if (n.tech < 2) fail('Reach tech level 2 to build aircraft.'); const b = airBatch(n), c = Math.round(b * 4.5e4 * cheap(n)), g = b * 15, s = b * 10, o = b * 10; if (n.cash < c || n.res.goods < g || n.res.steel < s || n.res.oil < o) fail(`Requires ${money(c)}, ${g} goods, ${s} steel and ${o} oil.`); n.cash -= c; n.res.goods -= g; n.res.steel -= s; n.res.oil -= o; n.air += b; msg = `${b} aircraft delivered.`; }
    else if (k === 'expand') {
      { const a = adminState(W, u); if (isFinite(a.cap) && a.used + ADMIN.colony > a.cap) fail(`Not enough administration to run another province (${a.used} of ${a.cap} used; a new colony needs ${ADMIN.colony}). Build Administrative offices, rank up, or wait for colonies to become core land after ${ADMIN.coreD} days.`); }
      // any unclaimed province can be settled: land next to yours at the normal price, anywhere else for more (see settleCost)
      let h = null;
      if (arg != null) { h = Number(arg); if (!Number.isInteger(h) || !P[h]) fail('Unknown province.'); if (W.OWN[h]) fail('That province is already claimed.'); }
      else { const ts = expandTargets(W, u); if (!ts.length) fail('No unclaimed land borders your nation. Tap any unclaimed province on the map to settle it from afar (it costs more the further away it is).');
        const pref = ts.filter(x => !['P', 'D'].includes(P[x].t)); const pool = pref.length ? pref : ts; h = pool[Math.floor(rng() * pool.length)]; }
      const sc = settleCost(W, u, h), c = sc.cash; if (n.cash < c || n.res.food < 40) fail(`Settling ${pname(h)}${sc.far ? ` (${num(sc.km)} km away)` : ''} requires ${money(c)} and 40 food.`);
      n.cash -= c; n.res.food -= 40; n.hexes[h] = W.now; n.lastStand = 0; W.OWN[h] = { u, ts: W.now }; msg = `Settled ${pname(h)} (${(TYPE[P[h].t] || TYPE.P).n.toLowerCase()}).`; W.selHex = h;
    }
    else if (k === 'research') { const c = researchCost(W, n), g = 10 + n.tech * 5; if (n.cash < c || n.res.goods < g) fail(`Requires ${money(c)} and ${g} goods.`); n.cash -= c; n.res.goods -= g; n.tech++; msg = `Tech level ${n.tech} reached.`; }
    else if (k === 'drill') { if (n.train >= maxTrain(n)) fail('Training is at the cap for your rank.'); const o = 10 + n.train * 2; if (n.res.oil < o) fail(`Requires ${o} oil.`); n.res.oil -= o; n.train++; n.morale = clamp(n.morale + 3, 0, 100); msg = `Training raised to ${n.train}.`; }
    else if (k === 'infra') { const c = infraCost(n), s = 20 + n.infra * 10; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.infra++; msg = `Infrastructure level ${n.infra}.`; }
    else if (k === 'fort') { const c = fortCost(n), s = 30 + n.fort * 15; if (n.cash < c || n.res.steel < s) fail(`Requires ${money(c)} and ${s} steel.`); n.cash -= c; n.res.steel -= s; n.fort++; msg = `Fortifications level ${n.fort}.`; }
    else if (k === 'spies') { if (n.spies >= spyCap(n)) fail(`Your intelligence agency is at capacity (${spyCap(n)} agents for your rank).`); const c = 8e4; if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.spies = Math.min(spyCap(n), n.spies + 2); msg = `Two agents completed training. You now have ${n.spies}.`; }
    else if (k === 'rally') { const c = rallyCost(n); if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.approval = clamp(n.approval + 6, 0, 100); msg = 'Your address was well received. Approval rose.'; }
    else if (k === 'campaign') { if (n.gov !== 'dem') fail('Only democracies hold elections.'); if (!n.nextElection || n.nextElection - W.now > 24 * HOUR) fail('Campaigning opens 24 hours before the election.'); if ((n.campaign || 0) >= 12) fail('Your campaign is already at full strength.'); const c = campaignCost(n); if (n.cash < c) fail(`Requires ${money(c)}.`); n.cash -= c; n.campaign = (n.campaign || 0) + 3; msg = `Campaign rallies held across the country. Projected vote +3% (total +${n.campaign}%).`; }
    else if (k === 'daily') { const st = n.streak && W.now - n.streak.t < 48 * HOUR ? n.streak.c + 1 : 1; n.streak = { c: st, t: W.now }; const sm = streakMult(st); const v = Math.round(dailyGrant(n) * sm); n.cash += v; if (st % 7 === 0) gainXP(W, u, 100); n.res.food += 100; n.res.oil += 60; n.res.steel += 60; n.res.goods += 30; msg = `Received a ${money(v)} grant and supplies.${st > 1 ? ` Day ${st} streak: ×${sm.toFixed(2)}${st % 7 === 0 ? ' — weekly bonus!' : '.'}` : ''}`; }
    n.cd[k] = W.now + a.cd * MIN * W.cfg.cd; n.cnt[k] = (n.cnt[k] || 0) + 1; gainXP(W, u, a.xp); log(n, msg, W); touch(W, u);
    return { msg };
  }

  function applyEff(W, u, e, rng) {
    const n = W.A[u];
    if (e.risk != null) { const ok = rng() < e.risk; applyEff(W, u, ok ? e.ok : e.bad, rng); return ok; }
    for (const [k, v] of Object.entries(e)) {
      if (k === 'tr') n.cash += v * taxIncome(W, u);
      else if (k === 'debt') { const amt = v * taxIncome(W, u); n.debt += amt; n.cash += amt; }
      else if (k === 'ap') n.approval = clamp(n.approval + v, 0, 100);
      else if (k === 'st') n.stability = clamp(n.stability + v, 0, 100);
      else if (k === 'pop') n.pop = Math.max(1000, n.pop * (1 + v / 100));
      else if (k === 'gdp') n.gdp = Math.max(1e5, n.gdp * (1 + v / 100));
      else if (k === 'troops') n.troops = Math.max(0, Math.min(troopCap(n), n.troops + v));
      else if (k === 'ships' || k === 'air' || k === 'spies') n[k] = Math.max(0, n[k] + v);
      else if (k === 'tech' || k === 'infra' || k === 'fort') n[k] = Math.max(0, n[k] + v);
      else if (k === 'train') n.train = clamp(n.train + v, 0, maxTrain(n));
      else if (k === 'aggr') { n.aggr = clamp((n.aggr || 0) + v, 0, 100); rogueCheck(W, u); }
      else if (k === 'unemp') n.unemp = clamp(n.unemp + v, 1, 40);
      else if (k === 'infl') n.infl = clamp(n.infl + v, -2, 80);
      else if (k === 'health' || k === 'edu' || k === 'morale') n[k] = clamp(n[k] + v, 0, 100);
      else if (has(RES, k)) n.res[k] = Math.max(0, n.res[k] + v);
      else if (k === 'boost' && v && v.h > 0) { const b = { t: W.now, until: W.now + v.h * HOUR, src: W._src || '' }; for (const x of BOOST_KEYS) if (v[x] != null) b[x] = v[x];
        // one boost per kind at a time: a new one replaces the old
        n.boosts = (n.boosts || []).filter(o => o.until > W.now && !BOOST_KEYS.some(x => o[x] != null && b[x] != null)); n.boosts.push(b); n.boosts = n.boosts.slice(-8); }
    }
    return true;
  }
  function addCard(W, u, rng) {
    const n = W.A[u];
    if (!n.chain && !n.cards.some(c => String(c.i).startsWith('ch:')) && rng() < .18) { const recent = n.seenCh || []; const opts = CHAIN_STARTS.filter(k => !recent.includes(k)); if (opts.length) { const k = opts[Math.floor(rng() * opts.length)]; n.cards.push({ id: rid(), i: 'ch:' + k }); n.seenCh = [k, ...recent].slice(0, 3); return; } } const used = new Set([...n.cards.map(c => c.i), ...(n.seen || [])]);
    let pool = CARDS.map((c, i) => i).filter(i => !used.has(i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) pool = CARDS.map((c, i) => i).filter(i => !n.cards.some(c => c.i === i) && condOk(W, u, CARDS[i].c));
    if (!pool.length) return;
    const weighted = []; for (const i of pool) { weighted.push(i); if (CARDS[i].c) weighted.push(i, i); }
    const i = weighted[Math.floor(rng() * weighted.length)];
    n.cards.push({ id: rid(), i }); n.seen = [i, ...(n.seen || [])].slice(0, 60);
  }
  function decide(W, u, id, o, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const c = n.cards.find(x => x.id === id); if (!c) fail('That decision is no longer pending.');
    const card = getCard(c.i), oi = Number(o); if (!card || !Number.isInteger(oi) || oi < 0 || oi >= card.o.length) fail('Invalid choice.'); const opt = card.o[oi];
    W._src = card.t; const ok = applyEff(W, u, opt[1], rng); W._src = ''; n.cards = n.cards.filter(x => x.id !== id); n.cnt.decide = (n.cnt.decide || 0) + 1; gainXP(W, u, 20);
    let clear = '';
    if (!n.cards.length) { const bonus = Math.round(taxIncome(W, u)); n.cash += bonus; n.approval = clamp(n.approval + 1, 0, 100); gainXP(W, u, 15); clear = ` Desk cleared: +${money(bonus)}, +1 approval and 15 bonus XP.`; }
    if (opt[2] && CHAINS[opt[2]]) n.chain = { k: opt[2], at: W.now + (30 + Math.floor(rng() * 30)) * MIN }; // the story continues later
    const msg = `${card.t}: ${opt[0]}${opt[1].risk != null ? (ok ? ' — it succeeded.' : ' — it backfired.') : '.'}`; log(n, msg, W); touch(W, u);
    return { msg: msg + clear, ok, clear: !!clear };
  }

  function attack(W, u, h, X, AIR, rng, mkVassal) { dropShield(W.A[u]);
    const me = W.A[u]; h = Number(h); if (!Number.isInteger(h) || !P[h]) fail('Unknown province.'); const why = canAttack(W, u, h); if (why) fail(why);
    X = Math.floor(Number(X)); AIR = Math.max(0, Math.floor(Number(AIR) || 0));
    if (!(X >= 10) || X > me.troops) fail('Commit at least 10 troops, and no more than you have.');
    if (AIR > me.air) fail('You do not have that many aircraft.');
    const RCH = reachBy(W, u, h), rt = RCH.rt, SEA = rt === 'sea' || rt === 'ocean', OCEAN = rt === 'ocean', MARCH = rt === 'march', AIRB = rt === 'air', perShip = PER_SHIP[rt] || 0, shipsNeeded = SEA ? Math.ceil(X / perShip) : 0;
    if (AIRB && AIR * AIRBORNE.per < X) fail(`An airborne invasion of ${num(X)} troops needs ${Math.ceil(X / AIRBORNE.per)} aircraft to fly them in (${AIRBORNE.per} troops each). Commit more aircraft or fewer troops.`);
    if (shipsNeeded > me.ships) fail(`${OCEAN ? 'An overseas' : 'A sea'} invasion of ${num(X)} troops needs ${shipsNeeded} warships to carry them (${perShip} troops each). You have ${me.ships}.`);
    const c = atkCost(W, X), cx = routeCostX(RCH, me); c.cash = Math.round(c.cash * cx); c.oil = Math.ceil(c.oil * cx); c.food = Math.ceil(c.food * cx); if (me.cash < c.cash || me.res.oil < c.oil + AIR * 2 || me.res.food < c.food) fail(`This operation requires ${money(c.cash)}, ${c.oil + AIR * 2} oil and ${c.food} food.`);
    const v = owner(W, h), d = W.A[v];
    me.cash -= c.cash; me.res.oil -= c.oil + AIR * 2; me.res.food -= c.food; me.cd.attack = W.now + 15 * MIN; me.regroup = W.now + (OCEAN || AIRB ? 60 : MARCH ? 45 : 30) * MIN; const retal = defending(W, u, v); me.aggr = addAggr(W, me, v, rogue(W, d) ? 0 : retal ? 0 : Math.round((hitRecently(W, u, v) ? 5 : W.m.aggrPerAttack * (measure(W, d, 'guarantee') ? 2 : 1)) * aggrScale(W, v))); rogueCheck(W, u);
    me.approval = clamp(me.approval - (me.gov === 'dem' ? 4 : me.gov === 'dic' ? 1 : 2), 0, 100); me.stability = clamp(me.stability - 1.5, 0, 100);
    const result = { h, X, air: AIR, route: rt, km: RCH.km, naval: null };
    // 1) naval battle for sea invasions
    if (SEA && d.ships > 0) {
      const atkN = me.ships * 25 * techF(me) * (.85 + rng() * .3), defN = navalDefense(W, h) * (.9 + rng() * .2), rn = defN / (atkN + defN);
      const lostA = Math.min(me.ships, Math.round(me.ships * rn * .4)), lostD = Math.min(d.ships, Math.round(d.ships * (1 - rn) * .4));
      me.ships -= lostA; d.ships -= lostD; result.naval = { win: atkN > defN, atk: Math.round(atkN), def: Math.round(defN), lostA, lostD };
      if (atkN <= defN) {
        const drowned = Math.round(X * .2); me.troops -= drowned;
        Object.assign(result, { win: false, atk: 0, def: Math.round(defN), lossA: drowned, lossD: 0, loot: 0, airLostA: 0, airLostD: 0 });
        aggrHit(W, u, v, 'battle'); pushOut(W, u, { type: 'battle', to: v, h, X, win: false, lossA: drowned, lossD: 0, loot: 0, sea: 1, ocean: OCEAN ? 1 : 0 });
        log(d, `Your navy turned back ${OCEAN ? 'an overseas' : 'a sea'} invasion of ${pname(h)} by ${me.name}.`, W); note(W, v, 'attack', `Your navy repelled a sea invasion of ${pname(h)} by ${me.name}.`);
        news(W, u, `${d.name}'s navy repelled a sea invasion of ${pname(h)} by ${me.name}.`); gainXP(W, u, 5); touch(W, u, v);
        result.sanctioned = sanctioned(me); return { msg: 'Defeat at sea.', battle: result };
      }
    }
    // 1b) airborne: the defender's air force shoots down some transports before the drop, and the troops aboard are lost
    if (AIRB) { const shot = d.air > 0 ? Math.min(AIR, Math.round(AIR * d.air / (d.air + AIR * 1.5) * (.15 + rng() * .2))) : 0, lostX = Math.min(X, shot * AIRBORNE.per);
      me.air -= shot; me.troops -= lostX; X -= lostX; AIR -= shot; result.airdrop = { shot, lostX };
      if (X < 10) { Object.assign(result, { win: false, atk: 0, def: 0, lossA: lostX, lossD: 0, loot: 0, airLostA: shot, airLostD: 0 });
        aggrHit(W, u, v, 'battle'); pushOut(W, u, { type: 'battle', to: v, h, X: X + lostX, win: false, lossA: lostX, lossD: 0, loot: 0, air: 1 });
        log(d, `Your air force shot down an airborne invasion of ${pname(h)} by ${me.name}.`, W); note(W, v, 'attack', `Your air force stopped an airborne invasion of ${pname(h)} by ${me.name}.`);
        news(W, u, `${d.name}'s air force shot down an airborne invasion of ${pname(h)} by ${me.name}.`); gainXP(W, u, 5); touch(W, u, v);
        result.sanctioned = sanctioned(me); return { msg: 'The airdrop was shot down.', battle: result }; } }
    // 2) land battle with air support
    const atk = (X + AIR * 20) * atkMult(me) * routeMult(RCH, me) * (rogue(W, d) ? 1.15 : 1) * Math.sqrt(gapF(me, d)) * (.85 + rng() * .3), def = defense(W, h, u) * (.9 + rng() * .2); const win = atk > def, ra = def / (atk + def);
    const lossA = Math.min(X, Math.round(X * ra * .6)), lossD = Math.min(d.troops, Math.round(d.troops * .5 * (1 - ra) * .5));
    const airLostA = Math.min(AIR, Math.round(AIR * ra * .3)), airLostD = Math.min(d.air, Math.round(d.air * .5 * (1 - ra) * .3));
    me.troops -= lossA; me.air -= airLostA; d.troops = Math.max(0, d.troops - lossD); d.air -= airLostD;
    let loot = 0;
    const isCap = !!(W.OWN[h] && W.OWN[h].cap);
    if (win && isCap && mkVassal) { result.vassal = true; loot = Math.max(0, Math.round(d.cash * VASSAL.loot)); me.cash += loot; d.cash -= loot; endWar(W, u, v); for (const x of vassalsOf(W, v)) { delete W.A[x].overlord; delete W.A[x].vassalT; touch(W, x); } d.overlord = u; d.vassalT = W.now; delete d.lastStand; gainXP(W, u, 150);
      log(me, `${d.name} surrendered and is now your vassal: it pays you tribute every 10 minutes. You took ${money(loot)} from its treasury.`, W); log(d, `${me.name} took your capital. You are now its vassal and pay it tribute. You may declare independence after ${VASSAL.freeH} hours.`, W);
      note(W, v, 'attack', `👑 ${me.name} took your capital. You are now its vassal: you keep your land but pay tribute. You can declare independence in ${VASSAL.freeH} hours.`); news(W, u, `👑 ${d.name} has surrendered and become a vassal of ${me.name}.`); Object.assign(result, { win, atk: Math.round(atk), def: Math.round(def), lossA, lossD, loot, airLostA, airLostD, sanctioned: sanctioned(me) }); seasonBump(W, me, 'wins'); pushOut(W, u, { type: 'battle', to: v, h, X, win, lossA, lossD, loot, vassal: 1, sea: SEA ? 1 : 0, ocean: OCEAN ? 1 : 0, air: AIRB ? 1 : 0 }); touch(W, u, v); return { msg: `👑 ${d.name} surrendered and is now your vassal.`, battle: result }; }
    else if (win && isCap) { result.conquered = true; if (d.wonders && Object.keys(d.wonders).length) { me.wonders = { ...(me.wonders || {}), ...d.wonders }; news(W, u, `${me.name} seized ${Object.keys(d.wonders).map(k => 'the ' + WONDERS[k].n).join(' and ')} from ${d.name}.`); d.wonders = {}; } loot = Math.max(0, Math.round(d.cash * .25)); me.cash += loot; for (const r in RES) me.res[r] = (me.res[r] || 0) + Math.floor((d.res[r] || 0) * .5); me.hexes[h] = W.now; me.lastStand = 0; gainXP(W, u, 150); }
    else if (false) { loot = Math.round(Math.max(0, Math.min(d.cash * .05, X * 60))); me.cash += loot; d.cash -= loot; delete d.hexes[h]; if (d.dev) delete d.dev[h]; if (d.conq) delete d.conq[h]; W.OWN = computeOwn(W.A); result.freed = true; d.approval = clamp(d.approval - 4, 0, 100); d.stability = clamp(d.stability - 3, 0, 100); gainXP(W, u, 40);
      log(me, `Your forces drove ${d.name} out of ${pname(h)}, but your empire is at its province limit (${maxHex(me)}), so the province is now free land.`, W); }
    else if (win) { loot = Math.round(Math.max(0, Math.min(d.cash * .05, X * 60))); me.cash += loot; d.cash -= loot; delete d.hexes[h]; xferDev(W, v, u, h, 1); me.hexes[h] = W.now; me.lastStand = 0; W.OWN[h] = { u, ts: W.now }; d.approval = clamp(d.approval - 4, 0, 100); d.stability = clamp(d.stability - 3, 0, 100); gainXP(W, u, 40);
      if (W.cfg.conquest && Object.keys(d.hexes).length === 1 && !d.lastStand) { d.lastStand = W.now; log(d, `Only your capital remains. In ${W.cfg.lastStandH ?? 24} hours it can be besieged — make peace, rally allies, fortify, or retake land.`, W); note(W, v, 'attack', `LAST STAND: ${d.name} has only its capital left. Enemies can besiege it in ${W.cfg.lastStandH ?? 24} hours.`); news(W, v, `${d.name} has lost all but its capital and is making a last stand.`); } }
    else gainXP(W, u, 5);
    Object.assign(result, { win, atk: Math.round(atk), def: Math.round(def), lossA, lossD, loot, airLostA, airLostD, sanctioned: sanctioned(me) }); if (win) seasonWin(W, u, v);
    // generals: victories can produce a new general and promote the commander; defeats can cost a general's life
    const ag = bestGen(me, 'attack');
    if (win) { if (ag) { ag.wins++; if (ag.wins % 3 === 0 && ag.stars < 5) { ag.stars++; result.genUp = ag.name; } } if (rng() < .25) { const g = newGeneral(W, u, rng); if (g) { result.newGen = g; log(me, `${g.name} distinguished themselves in battle and was appointed ${GEN_TYPES[g.type].n}.`, W); note(W, u, 'rank', `New general: ${g.name}, ${GEN_TYPES[g.type].n}.`); } }
      const dg = bestGen(d, 'defense'); if (dg && rng() < .15) { d.gens = d.gens.filter(x => x !== dg); log(d, `${dg.name}, your defense commander, was killed defending ${pname(h)}.`, W); note(W, v, 'attack', `General ${dg.name} was killed defending ${pname(h)}.`); } }
    else if (ag && rng() < .2) { me.gens = me.gens.filter(x => x !== ag); result.genLost = ag.name; log(me, `${ag.name}, your field marshal, was killed in the failed attack on ${pname(h)}.`, W); news(W, u, `General ${ag.name} of ${me.name} fell in battle at ${pname(h)}.`); }
    // newly conquered land may rebel unless it is garrisoned
    if (win && !isCap && !result.freed) { me.conq = me.conq || {}; me.conq[h] = { t: W.now, from: v }; }
    for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `${me.name} ${win ? 'captured' : 'attacked'} ${pname(h)} from your ally ${d.name}.`);
    aggrHit(W, u, v, 'battle'); pushOut(W, u, { type: 'battle', to: v, h, X, win, lossA, lossD, loot, sea: SEA ? 1 : 0, ocean: OCEAN ? 1 : 0, air: AIRB ? 1 : 0 });
    if (result.conquered) {
      const days = Math.max(0, (W.now - (d.created || W.now)) / 864e5);
      news(W, u, `${me.name} has conquered ${d.name}. ${d.name} has fallen after ${days < 1 ? 'less than a day' : Math.floor(days) + ' day' + (Math.floor(days) === 1 ? '' : 's')}.`);
      log(me, `You conquered ${d.name}, seizing ${pname(h)}, ${money(loot)} and half its stockpiles.`, W);
      fallNation(W, v, { by: u, byName: me.name, h, days, peakRank: rankName(d), xp: d.xp, name: d.name, color: d.color });
      touch(W, u); return { msg: 'Conquest.', battle: result };
    }
    const how = AIRB ? 'an airborne invasion of' : OCEAN ? 'an overseas invasion of' : rt === 'sea' ? 'an amphibious assault on' : MARCH ? 'a long-range offensive against' : 'an invasion of';
    log(d, win ? `${me.name} captured ${pname(h)} in ${how.replace('an ', '')}. Losses: ${num(lossD)} troops${loot ? ', ' + money(loot) : ''}.` : `Your forces repelled ${how} ${pname(h)} by ${me.name}. Losses: ${num(lossD)} troops.`, W);
    note(W, v, 'attack', win ? `${me.name} captured ${pname(h)}!` : `You repelled ${how} ${pname(h)} by ${me.name}.`);
    news(W, u, win ? `${me.name} captured ${pname(h)} from ${d.name}${AIRB ? ' in an airborne invasion' : OCEAN ? ' in an overseas invasion' : rt === 'sea' ? ' in an amphibious assault' : ''}.` : `${d.name} repelled ${how} ${pname(h)} by ${me.name}.`);
    touch(W, u, v);
    return { msg: win ? 'Victory.' : 'Defeat.', battle: result };
  }

  // air and missile strikes: damage without invading
  function canStrike(W, u, v, noRearm) {
    const me = W.A[u], n = W.A[v]; if (!me) return 'Found a nation first.'; if (!n || v === u) return 'Unknown nation.';
    if (n.overlord === u || me.overlord === v) return n.overlord === u ? `${n.name} is your vassal.` : `You are ${n.name}'s vassal.`;
    if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    if (rankOf(me.xp) < 2) return 'You must reach the rank of Mayor to wage war.';
    if (!atWar(W, u, v)) return `You are not at war with ${n.name}. Declare war first.`;
    { const cf = ceasefireMsg(W, me, n); if (cf) return cf; }
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    const theyHitMe = hitRecently(W, u, v);
    if (!theyHitMe && !n.ai && W.now - n.created < W.cfg.protectH * HOUR && !(n.out || []).some(e => e.type === 'battle')) return `${n.name} is under new-nation protection.`;
    if (shieldOn(W, n)) return `${n.name} is rebuilding under international protection for another ${fmtT(n.shield - W.now)}.`;
    if (!noRearm && left(W, me, 'strike')) return `Your strike forces are rearming: ${fmtT(left(W, me, 'strike'))}.`;
    return null;
  }
  const MISSILE = { tech: 15, cash: 4e5, steel: 40, oil: 40, mun: 10 };
  // missiles per strike: 5 at tech 15, +1 for every 2 tech levels above that, +1 each at Senator, President and Emperor (up to 10), then +1 for every 4 provinces (up to 10 more)
  const maxMissiles = n => { if (!n || (n.tech || 0) < MISSILE.tech) return 0; const r = rankOf(n.xp); return Math.min(10, 5 + Math.floor(((n.tech || 0) - MISSILE.tech) / 2) + (r >= 4 ? 1 : 0) + (r >= 6 ? 1 : 0) + (r >= 8 ? 1 : 0)) + Math.min(10, Math.floor(hexN(n) / 4)); };
  function strike(W, u, v, kind, target, count, rng) { dropShield(W.A[u]);
    const why = canStrike(W, u, v); if (why) fail(why);
    const me = W.A[u], d = W.A[v]; if (!['stock', 'infra', 'mil'].includes(target)) fail('Choose a target.');
    count = Math.floor(Number(count)); let P = 0, lost = 0, hits = 0, icept = 0;
    if (kind === 'air') {
      if (!(count >= 5) || count > (me.air || 0)) fail(`Send between 5 and ${me.air || 0} aircraft.`);
      if (me.res.oil < count * 3) fail(`Needs ${count * 3} oil.`);
      me.res.oil -= count * 3; const icp = (d.air || 0) / ((d.air || 0) + count + 1);
      lost = Math.min(count, Math.round(count * icp * .6 + count * .03)); me.air -= lost; P = (count - lost) * techF(me) * gapF(me, d);
    } else if (kind === 'missile') {
      if ((me.tech || 0) < MISSILE.tech) fail(`Missiles require tech level ${MISSILE.tech}.`);
      const mx = maxMissiles(me); if (!(count >= 1) || count > mx) fail(`Launch between 1 and ${mx} missiles.`);
      const c = { cash: MISSILE.cash * count, steel: MISSILE.steel * count, oil: MISSILE.oil * count, mun: MISSILE.mun * count };
      if (me.cash < c.cash || me.res.steel < c.steel || me.res.oil < c.oil || (me.res.mun || 0) < c.mun) fail(`${count} missile${count > 1 ? 's need' : ' needs'} ${money(c.cash)}, ${c.steel} steel, ${c.oil} oil and ${c.mun} munitions${(me.res.mun || 0) < c.mun ? ` (you have ${num(Math.floor(me.res.mun || 0))} munitions; make more on the Military page)` : ''}.`);
      me.cash -= c.cash; me.res.steel -= c.steel; me.res.oil -= c.oil; me.res.mun -= c.mun;
      // a far more advanced target's air defences shoot down more of the missiles, and the ones that land do less (together: the tech gap factor)
      const g = gapF(me, d), hp = clamp(.85 - soft(d.fort, 8) * .04, .4, .9) * Math.min(1, Math.sqrt(g)), dm = domeOn(W, d); for (let i = 0; i < count; i++) { if (dm && rng() < domeMis(d)) { icept++; continue; } if (rng() < hp) hits++; } P = hits * 12 * techF(me) * (g < 1 ? Math.sqrt(g) : g);
    } else fail('Unknown strike.');
    const dmg = {};
    if (target === 'stock') { const f = Math.min(.3, P * .004); for (const r in RES) { dmg[r] = Math.floor((d.res[r] || 0) * f); d.res[r] -= dmg[r]; } }
    else if (target === 'infra') { const lv = P >= 40 ? 2 : P >= 15 ? 1 : 0; dmg.infra = Math.min(d.infra || 0, lv); d.infra -= dmg.infra; dmg.gdp = Math.min(.05, P * .0008); d.gdp = (d.gdp || 0) * (1 - dmg.gdp); }
    else { dmg.troops = Math.min(Math.floor((d.troops || 0) * .15), Math.round(P * 25)); d.troops -= dmg.troops; dmg.ships = Math.min(d.ships || 0, Math.floor(P / 15)); d.ships -= dmg.ships; dmg.air = Math.min(d.air || 0, Math.floor(P / 20)); d.air -= dmg.air; }
    me.cd.strike = W.now + 30 * MIN; me.aggr = addAggr(W, me, v, rogue(W, d) ? 0 : defending(W, u, v) ? 0 : Math.round((hitRecently(W, u, v) ? 3 : 8 * (measure(W, d, 'guarantee') ? 2 : 1)) * aggrScale(W, v))); rogueCheck(W, u); me.approval = clamp(me.approval - (me.gov === 'dem' ? 4 : 2), 0, 100);
    const what = target === 'stock' ? 'stockpiles' : target === 'infra' ? 'infrastructure' : 'military';
    const sum = target === 'stock' ? (Object.entries(dmg).filter(([, x]) => x > 0).map(([r, x]) => `${num(x)} ${rName(r)}`).join(', ') || 'almost nothing') + ' destroyed'
      : target === 'infra' ? (dmg.infra ? `infrastructure −${dmg.infra} level${dmg.infra > 1 ? 's' : ''}` : 'no infrastructure destroyed') + `, GDP −${(dmg.gdp * 100).toFixed(1)}%`
      : `${num(dmg.troops)} troops killed${dmg.ships ? `, ${dmg.ships} warships sunk` : ''}${dmg.air ? `, ${dmg.air} aircraft destroyed` : ''}`;
    const how = kind === 'air' ? `air strike (${count} aircraft${lost ? `, ${lost} shot down` : ''})` : `missile strike (${hits} of ${count} hit)`;
    log(me, `Your ${how} on ${d.name}'s ${what}: ${sum}.`, W); log(d, `${me.name} launched a ${how.replace(/ \(.*/, '')} on your ${what}: ${sum}.`, W);
    note(W, v, 'attack', `${me.name} hit your ${what} with a ${kind === 'air' ? 'air' : 'missile'} strike.`); news(W, u, `${me.name} launched ${kind === 'air' ? 'air strikes' : 'missiles'} against ${d.name}.`);
    for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `${me.name} launched a ${kind === 'air' ? 'air' : 'missile'} strike on your ally ${d.name}.`);
    gainXP(W, u, 10); touch(W, u, v);
    // what everyone sees on the globe: the flight from the attacker's capital to one of the target's provinces
    aggrHit(W, u, v, kind === 'air' ? 'air strike' : 'missile strike');
    { const hs = hexesOf(W, v), hh = hs.length ? hs[Math.floor(rng() * hs.length)] : d.cap; (W.strikeFx = W.strikeFx || []).push({ id: rid(), by: u, byName: me.name, to: v, toName: d.name, from: me.cap, h: hh, place: pname(hh), kind, n: count, lost, hits, icept, target, t: W.now }); }
    if (icept) { note(W, v, 'attack', `🛡 Your Golden Dome shot down ${icept} of ${count} missile${count > 1 ? 's' : ''} fired by ${me.name}.`); }
    return { msg: `Strike complete — ${sum}.${icept ? ` Their Golden Dome shot down ${icept} of your ${count} missiles.` : ''}`, strike: { kind, target, count, lost, hits, icept, dmg, sum } };
  }
  // DIRTY BOMB: a missile with radioactive material. Cheaper and far weaker than a nuke, but it leaves a radioactive cloud over one province for 24 hours.
  function canDirty(W, u, v) {
    const why = canStrike(W, u, v); if (why) return why; const me = W.A[u];
    if (W.m.nonukes) return 'A World Council nuclear weapons ban is in force: no dirty bombs until it expires.';
    if ((me.tech || 0) < DIRTY.tech) return `A dirty bomb requires tech level ${DIRTY.tech}.`;
    if (!W.cfg.nukeTest && rankOf(me.xp) < DIRTY.rank) return `A dirty bomb requires the rank of ${RANKS[DIRTY.rank][1]}.`;
    if (left(W, me, 'dirty') && !W.cfg.nukeTest) return `Your next dirty bomb will be ready in ${fmtT(left(W, me, 'dirty'))}.`;
    if (me.cash < DIRTY.cash || (me.res.steel || 0) < DIRTY.steel || (me.res.oil || 0) < DIRTY.oil || (me.res.goods || 0) < DIRTY.goods || (me.res.mun || 0) < DIRTY.mun) return `A dirty bomb costs ${money(DIRTY.cash)}, ${num(DIRTY.steel)} steel, ${num(DIRTY.oil)} oil, ${num(DIRTY.goods)} goods and ${num(DIRTY.mun)} munitions.`;
    return null;
  }
  function dirtyBomb(W, u, v, rng) {
    const why = canDirty(W, u, v); if (why) fail(why); const me = W.A[u], d = W.A[v];
    me.cash -= DIRTY.cash; me.res.steel -= DIRTY.steel; me.res.oil -= DIRTY.oil; me.res.goods -= DIRTY.goods; me.res.mun -= DIRTY.mun; const g = gapF(me, d);
    me.cd.dirty = W.now + DIRTY.cdH * HOUR; me.cd.strike = W.now + 30 * MIN;
    const hs = hexesOf(W, v), h = hs.length ? hs[Math.floor(rng() * hs.length)] : d.cap, icept = domeOn(W, d) && rng() < domeMis(d) ? 1 : 0, dmg = {};
    if (!icept) {
      dmg.troops = Math.floor((d.troops || 0) * .06 * g); d.troops -= dmg.troops; dmg.pop = Math.floor((d.pop || 0) * .02 * g); d.pop -= dmg.pop; dmg.food = Math.floor((d.res.food || 0) * .1 * g); d.res.food -= dmg.food;
      d.gdp = (d.gdp || 0) * .97; d.approval = clamp(d.approval - 5, 0, 100); d.stability = clamp(d.stability - 6, 0, 100);
      d.rad = { h, t: W.now, until: W.now + DIRTY.h * HOUR, by: u };
    }
    const def = defending(W, u, v); me.aggr = addAggr(W, me, v, rogue(W, d) || def ? 0 : Math.round(DIRTY.aggr * aggrScale(W, v))); if (!d.ai && !def && !rogue(W, d)) me.dirtyAt = W.now;
    rogueCheck(W, u); me.approval = clamp(me.approval - 5, 0, 100);
    const place = pname(h), sum = icept ? `${d.name}'s Golden Dome shot it down` : `${num(dmg.troops)} troops and ${num(dmg.pop)} people lost, ${num(dmg.food)} food contaminated, and a radioactive cloud will hang over ${place} for ${DIRTY.h} hours`;
    log(me, `Your dirty bomb on ${place}, ${d.name}: ${sum}.`, W); log(d, icept ? `🛡 Your Golden Dome shot down a dirty bomb fired by ${me.name}.` : `☢ ${me.name} detonated a dirty bomb over ${place}: ${sum}.`, W);
    note(W, v, 'attack', icept ? `🛡 Your Golden Dome shot down a dirty bomb fired by ${me.name}.` : `☢ ${me.name} detonated a dirty bomb over ${place}. A radioactive cloud hangs over the province for ${DIRTY.h} hours.`);
    news(W, u, icept ? `☢ ${me.name} fired a dirty bomb at ${d.name}, but it was shot down by the Golden Dome.` : `☢ ${me.name} detonated a dirty bomb over ${place}, ${d.name}. A radioactive cloud hangs over the province.`);
    for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `☢ ${me.name} used a dirty bomb on your ally ${d.name}.`);
    gainXP(W, u, 10); touch(W, u, v); aggrHit(W, u, v, 'dirty bomb');
    (W.strikeFx = W.strikeFx || []).push({ id: rid(), by: u, byName: me.name, to: v, toName: d.name, from: me.cap, h, place, kind: 'missile', dirty: 1, n: 1, lost: 0, hits: icept ? 0 : 1, icept, target: 'dirty', t: W.now });
    return { msg: icept ? `Their Golden Dome shot down your dirty bomb.` : `Dirty bomb detonated over ${place}: ${sum}.`, dirty: { h, icept, dmg } };
  }
  // HEAVY WEAPONS: ballistic missiles, naval bombardment, cyber attacks and EMP strikes. Each has its own cooldown, separate from air and missile strikes.
  const coastOf = (W, u) => hexesOf(W, u).filter(isCoastal);
  function canHeavy(W, u, v, k) {
    const H = HEAVY[k]; if (!H) return 'Unknown weapon.'; const why = canStrike(W, u, v, true); if (why) return why; const me = W.A[u], d = W.A[v];
    if ((me.tech || 0) < H.tech) return `${H.n} requires tech level ${H.tech}.`;
    if (rankOf(me.xp) < H.rank) return `${H.n} requires the rank of ${RANKS[H.rank][1]}.`;
    if (left(W, me, 'hv_' + k)) return `Your next ${hvN(H)} is ready in ${fmtT(left(W, me, 'hv_' + k))}.`;
    if ((H.mun || 0) > (me.res.mun || 0)) return `${H.n} needs ${num(H.mun)} munitions (you have ${num(Math.floor(me.res.mun || 0))}). Make more on the Military page or buy them on the market.`;
    if (k === 'blockade') { if (!coastOf(W, u).length) return 'You need a coastal province to send a fleet from.'; if (!coastOf(W, v).length) return `${d.name} has no coast to blockade.`; if ((me.ships || 0) < H.ships) return `A blockade needs at least ${H.ships} warships (you have ${me.ships || 0}).`; if ((me.res.oil || 0) < H.oilPer * me.ships) return `Needs ${num(H.oilPer * me.ships)} oil (${H.oilPer} per warship).`; return null; }
    if (k === 'carpet') { if ((me.air || 0) < H.air) return `Carpet bombing needs at least ${H.air} aircraft (you have ${me.air || 0}).`; if ((me.res.oil || 0) < H.oilPer * Math.min(me.air, 200)) return `Needs ${num(H.oilPer * Math.min(me.air, 200))} oil to fuel the bombers.`; }
    if (k === 'sub') { if (!coastOf(W, u).length) return 'You need a coastal province to send submarines from.'; if (!coastOf(W, v).length) return `${d.name} has no coast.`; if ((me.ships || 0) < H.ships) return `A submarine strike needs at least ${H.ships} warships (you have ${me.ships || 0}).`; if (!(d.ships > 0)) return `${d.name} has no warships to sink.`; }
    if (k === 'bombard') { if (!coastOf(W, u).length) return 'You need a coastal province to bombard from.'; if (!coastOf(W, v).length) return `${d.name} has no coast to bombard.`; if ((me.ships || 0) < H.ships) return `A bombardment needs at least ${H.ships} warships (you have ${me.ships || 0}).`; if ((me.res.oil || 0) < H.oilPer * me.ships) return `Needs ${num(H.oilPer * me.ships)} oil (${H.oilPer} per warship).`; return null; }
    const c = heavyCost(k); if (me.cash < (c.cash || 0) || (me.res.steel || 0) < (c.steel || 0) || (me.res.oil || 0) < (c.oil || 0) || (me.res.goods || 0) < (c.goods || 0)) return `${H.n} costs ${heavyCostTxt(k)}.`;
    return null;
  }
  const heavyCost = k => { const H = HEAVY[k]; return { cash: H.cash || 0, steel: H.steel || 0, oil: H.oil || 0, goods: H.goods || 0 }; };
  const heavyCostTxt = k => { const c = heavyCost(k); return [c.cash ? money(c.cash) : '', c.steel ? `${num(c.steel)} steel` : '', c.oil ? `${num(c.oil)} oil` : '', c.goods ? `${num(c.goods)} goods` : ''].filter(Boolean).join(', ') || (k === 'carpet' ? 'oil for the bombers' : 'oil for the fleet'); };
  // a weapon's effects against this target: the tech gap shrinks (or grows) every loss it causes
  const hvScale = (H, g) => { if (g === 1) return H; const o = { ...H }; for (const x of ['pop', 'troops', 'air', 'steal', 'res', 'sink', 'st']) if (typeof o[x] === 'number') o[x] = o[x] * g; if (o.stealMax) o.stealMax = o.stealMax * Math.min(1, g); if (o.tax) o.tax = 1 - (1 - o.tax) * g; if (o.research) o.research = 1 + (o.research - 1) * g; if (o.gdp) o.gdp = o.gdp < .5 ? o.gdp * g : 1 - (1 - o.gdp) * g; o.g = g; return o; };
  const penalty = (W, n, b, h) => { const o = { t: W.now, until: W.now + h * HOUR, src: 'attack' }; for (const x of BOOST_KEYS) if (b[x] != null) o[x] = b[x]; n.boosts = (n.boosts || []).filter(q => q.until > W.now && !BOOST_KEYS.some(x => q[x] != null && o[x] != null)); n.boosts.push(o); n.boosts = n.boosts.slice(-8); };
  // 'an artillery barrage', 'an EMP strike', 'a hypersonic missile'
  const hvN = H => /^[A-Z]{2}/.test(H.n) ? H.n : H.n[0].toLowerCase() + H.n.slice(1);
  const hvA = H => { const nm = hvN(H); return (/^[aeiou]/i.test(nm) ? 'an ' : 'a ') + nm; };
  function heavy(W, u, v, k, rng) {
    const why = canHeavy(W, u, v, k); if (why) fail(why); dropShield(W.A[u]); const me = W.A[u], d = W.A[v], R = rng || Math.random, G = gapF(me, d), H = hvScale(HEAVY[k], G);
    me.res.mun = (me.res.mun || 0) - (H.mun || 0);
    // whole levels (infrastructure, development) are lost with a chance that shrinks with the tech gap
    const lv = x => { const y = x * Math.min(1, G); return Math.floor(y) + (R() < y - Math.floor(y) ? 1 : 0); };
    if (k !== 'bombard' && k !== 'blockade' && k !== 'carpet') { const c = heavyCost(k); me.cash -= c.cash; me.res.steel -= c.steel; me.res.oil -= c.oil; me.res.goods -= c.goods; }
    me.cd['hv_' + k] = W.now + H.cdH * HOUR;
    const hs = k === 'bombard' || k === 'blockade' ? coastOf(W, v) : hexesOf(W, v), h0 = hs.length ? hs[Math.floor(R() * hs.length)] : d.cap, h = k === 'orbital' ? d.cap : k === 'raid' || k === 'cruise' ? (hexesOf(W, v).filter(x => devLvl(d, x) > 0).sort((a, b) => devLvl(d, b) - devLvl(d, a))[0] ?? h0) : h0, place = pname(h), dmg = {};
    let sum = '', icept = 0, traced = true, fxKind = 'missile', from = me.cap, lost = 0, fxH = h, fxN = 0;
    const nearOwn = list => list.length ? list.slice().sort((a, b) => kmBetween(+a, +fxH) - kmBetween(+b, +fxH))[0] : me.cap;
    if (k === 'ballistic') {
      icept = domeOn(W, d) && R() < domeMis(d) * H.domeX ? 1 : 0;
      if (!icept) { dmg.pop = Math.floor((d.pop || 0) * H.pop); d.pop -= dmg.pop; dmg.troops = Math.floor((d.troops || 0) * H.troops); d.troops -= dmg.troops; dmg.infra = Math.min(d.infra || 0, lv(H.infra)); d.infra -= dmg.infra; d.gdp = (d.gdp || 0) * (1 - H.gdp); d.stability = clamp(d.stability - H.st, 0, 100); d.approval = clamp(d.approval - 4, 0, 100); }
      sum = icept ? `${d.name}'s Golden Dome shot it down` : `${num(dmg.pop)} people and ${num(dmg.troops)} troops killed${dmg.infra ? ', infrastructure −1' : ''}, GDP −${Math.round(H.gdp * 100)}%`;
    } else if (k === 'bombard') {
      const S = me.ships, E = d.ships || 0; me.res.oil -= H.oilPer * S; lost = Math.min(S, Math.round(S * (E / (E + S + 1)) * .3 + S * .02)); me.ships -= lost;
      const Pw = (S - lost) * techF(me) * G; dmg.troops = Math.min(Math.floor((d.troops || 0) * .15), Math.round(Pw * 15)); d.troops -= dmg.troops; dmg.ships = Math.min(d.ships || 0, Math.floor(Pw / 12)); d.ships -= dmg.ships;
      dmg.infra = Pw >= 60 ? Math.min(d.infra || 0, 1) : 0; d.infra -= dmg.infra; dmg.gdp = Math.min(.04, Pw * .0005); d.gdp = (d.gdp || 0) * (1 - dmg.gdp);
      const mc = coastOf(W, u); from = mc.length ? mc.sort((a, b) => kmBetween(+a, +h) - kmBetween(+b, +h))[0] : me.cap;
      sum = `${num(dmg.troops)} troops killed${dmg.ships ? `, ${dmg.ships} warships sunk` : ''}${dmg.infra ? ', infrastructure −1' : ''}, GDP −${(dmg.gdp * 100).toFixed(1)}%${lost ? ` (you lost ${lost} warship${lost > 1 ? 's' : ''})` : ''}`;
    } else if (k === 'cyber') {
      traced = R() < H.trace; fxKind = null; penalty(W, d, { tax: H.tax, research: H.research }, H.h); d.stability = clamp(d.stability - 3, 0, 100);
      sum = `tax revenue −${Math.round((1 - H.tax) * 100)}% and research costs +${Math.round((H.research - 1) * 100)}% for ${H.h} hours`;
    } else if (k === 'hypersonic' || k === 'orbital') {
      dmg.pop = Math.floor((d.pop || 0) * H.pop); d.pop -= dmg.pop; dmg.troops = Math.floor((d.troops || 0) * H.troops); d.troops -= dmg.troops; dmg.infra = Math.min(d.infra || 0, lv(H.infra)); d.infra -= dmg.infra; d.gdp = (d.gdp || 0) * (1 - H.gdp); d.stability = clamp(d.stability - H.st, 0, 100); d.approval = clamp(d.approval - 5, 0, 100);
      if (k === 'orbital' && devLvl(d, h) > 0 && lv(1)) { d.dev[h]--; dmg.dev = 1; } if (k === 'orbital') from = h;
      sum = `${num(dmg.pop)} people and ${num(dmg.troops)} troops killed${dmg.infra ? `, infrastructure −${dmg.infra}` : ''}${dmg.dev ? `, ${place} lost a development level` : ''}, GDP −${Math.round(H.gdp * 100)}%. No shield could stop it`;
    } else if (k === 'drones') {
      const lostP = Math.min(.8, (d.air || 0) / ((d.air || 0) + 200)); lost = Math.round(100 * lostP); dmg.troops = Math.floor((d.troops || 0) * H.troops * (1 - lostP)); d.troops -= dmg.troops; dmg.air = Math.floor((d.air || 0) * H.air * (1 - lostP)); d.air -= dmg.air;
      sum = `${num(dmg.troops)} troops${dmg.air ? ` and ${dmg.air} aircraft` : ''} destroyed${lost ? ` (their air force shot down ${lost}% of the swarm)` : ''}`; lost = 0;
    } else if (k === 'blockade') {
      const S = me.ships, E = d.ships || 0; me.res.oil -= H.oilPer * S; lost = Math.min(S, Math.round(S * (E / (E + S + 1)) * .2)); me.ships -= lost; penalty(W, d, { tax: H.tax, gdp: H.gdp }, H.h); d.blockade = W.now + H.h * HOUR; d.blockH = h;
      sum = `their tax revenue −${Math.round((1 - H.tax) * 100)}% and GDP −${Math.round((1 - H.gdp) * 100)}% for ${H.h} hours, and their market trade is cut off${lost ? ` (you lost ${lost} warship${lost > 1 ? 's' : ''})` : ''}`; fxKind = 'sea'; from = nearOwn(coastOf(W, u)); fxN = 6;
    } else if (k === 'raid') {
      const p = clamp(.75 - (d.fort || 0) * .03 - (d.spies || 0) * .005 + ((me.tech || 0) - (d.tech || 0)) * .01, .3, .85);
      if (R() < p) { dmg.cash = Math.round(Math.min(H.stealMax, Math.max(0, d.cash) * H.steal)); d.cash -= dmg.cash; me.cash += dmg.cash; const rk = Object.keys(RES).sort((a, b) => (d.res[b] || 0) - (d.res[a] || 0))[0]; dmg.res = Math.floor((d.res[rk] || 0) * H.res); d.res[rk] -= dmg.res; me.res[rk] = (me.res[rk] || 0) + dmg.res; if (devLvl(d, h) > 0 && lv(1)) { d.dev[h]--; dmg.dev = 1; }
        sum = `your commandos seized ${money(dmg.cash)} and ${num(dmg.res)} ${rName(rk)}${dmg.dev ? `, and wrecked a development level in ${place}` : ''}`; }
      else { traced = true; d.cb = d.cb || {}; d.cb[u] = Math.max(d.cb[u] || 0, W.now + 24 * HOUR); me.troops = Math.max(0, (me.troops || 0) - 200); sum = `the raid on ${place} failed and your commandos were captured; ${d.name} has a 24-hour just cause against you`; dmg.failed = 1; }
      fxKind = 'air'; from = nearOwn(hexesOf(W, u)); fxN = 3;
    } else if (k === 'artillery') {
      fxKind = 'missile'; const fz = Math.max(0, 1 - (d.fort || 0) * .04); dmg.troops = Math.floor((d.troops || 0) * H.troops * fz); d.troops -= dmg.troops; dmg.fort = Math.min(d.fort || 0, lv(H.fort)); d.fort = (d.fort || 0) - dmg.fort; d.stability = clamp(d.stability - 1, 0, 100);
      const mine = hexesOf(W, u); from = mine.length ? mine.sort((a, b) => kmBetween(+a, +h) - kmBetween(+b, +h))[0] : me.cap;
      sum = `${num(dmg.troops)} troops killed${dmg.fort ? ', fortifications −1' : ''}`;
    } else if (k === 'cruise') {
      icept = domeOn(W, d) && R() < domeMis(d) * H.domeX ? 1 : 0;
      if (!icept) { if (devLvl(d, h) > 0 && lv(1)) { d.dev[h]--; dmg.dev = 1; } dmg.infra = Math.min(d.infra || 0, lv(H.infra)); d.infra -= dmg.infra; dmg.troops = Math.floor((d.troops || 0) * H.troops); d.troops -= dmg.troops; d.stability = clamp(d.stability - 2, 0, 100); }
      sum = icept ? `${d.name}'s Golden Dome shot it down` : `a precision hit on ${place}${dmg.dev ? ' destroyed a development level' : ''}${dmg.infra ? ', infrastructure −1' : ''}, ${num(dmg.troops)} troops killed`;
    } else if (k === 'carpet') {
      fxKind = 'air'; const A_ = Math.min(me.air, 200), E = d.air || 0; me.res.oil -= H.oilPer * A_; lost = Math.min(A_, Math.round(A_ * (E / (E + A_ * 2 + 1)) * .35)); me.air -= lost;
      const f = (A_ - lost) / Math.max(1, A_); dmg.pop = Math.floor((d.pop || 0) * H.pop * f); d.pop -= dmg.pop; dmg.troops = Math.floor((d.troops || 0) * H.troops * f); d.troops -= dmg.troops; dmg.infra = f > .5 ? Math.min(d.infra || 0, lv(H.infra)) : 0; d.infra -= dmg.infra; d.stability = clamp(d.stability - H.st, 0, 100); d.approval = clamp(d.approval - 3, 0, 100);
      sum = `${num(dmg.pop)} people and ${num(dmg.troops)} troops killed${dmg.infra ? ', infrastructure −1' : ''}${lost ? ` (their air defences shot down ${lost} of your ${A_} bombers)` : ''}`;
    } else if (k === 'sub') {
      fxKind = 'sea'; { const tc = coastOf(W, v); fxH = tc.length ? tc[Math.floor(R() * tc.length)] : h; } from = nearOwn(coastOf(W, u)); fxN = 3; const E = d.ships || 0, sunk = Math.max(G < .6 ? 0 : 1, Math.round(E * H.sink)); dmg.ships = Math.min(E, sunk); d.ships -= dmg.ships; lost = R() < .3 ? 1 : 0; me.ships -= lost;
      sum = dmg.ships ? `${dmg.ships} of their warship${dmg.ships > 1 ? 's' : ''} torpedoed and sunk${lost ? ' (you lost a submarine)' : ''}` : `their far more advanced fleet evaded every torpedo${lost ? ' (you lost a submarine)' : ''}`;
    } else if (k === 'emp') {
      d.empT = W.now + H.h * HOUR; dmg.air = Math.floor((d.air || 0) * H.air); d.air -= dmg.air; d.gdp = (d.gdp || 0) * (1 - H.gdp); penalty(W, d, { tax: H.tax }, H.h); d.stability = clamp(d.stability - 6, 0, 100);
      sum = `${num(dmg.air)} aircraft knocked out, GDP −${Math.round(H.gdp * 100)}%, tax revenue −${Math.round((1 - H.tax) * 100)}%${d.dome ? ' and the Golden Dome offline' : ''} for ${H.h} hours`;
    }
    const def = defending(W, u, v), add = !traced || rogue(W, d) || def ? 0 : Math.round(H.aggr * aggrScale(W, v)); me.aggr = addAggr(W, me, v, add); rogueCheck(W, u);
    if (traced) me.approval = clamp(me.approval - (k === 'emp' ? 5 : k === 'ballistic' ? 4 : 2), 0, 100);
    const who = traced ? me.name : 'Unknown hackers';
    log(me, `Your ${hvN(H)} on ${k === 'cyber' ? d.name : `${place}, ${d.name}`}: ${sum}.${k === 'cyber' ? traced ? ' The attack was traced back to you.' : ' It was not traced back to you.' : ''}`, W);
    log(d, `${H.ic} ${who} ${k === 'cyber' ? 'broke into your government networks' : `hit ${place} with ${hvA(H)}`}: ${sum}.`, W);
    note(W, v, 'attack', `${H.ic} ${who} ${k === 'cyber' ? 'launched a cyber attack on your nation' : `hit ${place} with ${hvA(H)}`}: ${sum}.`);
    if (traced) { news(W, u, icept ? `${H.ic} ${me.name} fired ${hvA(H)} at ${d.name}, but the Golden Dome shot it down.` : `${H.ic} ${me.name} ${k === 'cyber' ? `launched a cyber attack on ${d.name}` : `hit ${place}, ${d.name}, with ${hvA(H)}`}.`); for (const a of allies(W, v)) if (a !== u) note(W, a, 'war', `${H.ic} ${me.name} used ${hvA(H)} on your ally ${d.name}.`); aggrHit(W, u, v, hvN(H)); }
    gainXP(W, u, 12); touch(W, u, v);
    if (fxKind) (W.strikeFx = W.strikeFx || []).push({ id: rid(), by: u, byName: me.name, to: v, toName: d.name, from, h: fxH, noburn: k === 'blockade' || k === 'sub' || k === 'raid' || k === 'emp' ? 1 : 0, place: fxH === h ? place : pname(fxH), kind: k === 'drones' ? 'air' : fxKind, heavy: k, n: fxN ? fxN : k === 'bombard' ? me.ships + lost : k === 'drones' ? 12 : k === 'carpet' ? 7 : k === 'artillery' ? 3 : 1, lost, hits: icept ? 0 : 1, icept, target: k, t: W.now });
    return { msg: `${H.ic} ${H.n}: ${sum}.${k === 'cyber' ? traced ? ' They traced it back to you.' : ' They don\'t know it was you.' : ''}`, heavy: { k, h, icept, traced, dmg } };
  }
  // GOLDEN DOME: a national missile shield. Very expensive, takes 12 hours to build, costs upkeep, and shoots down 75% of incoming missiles and 40% of nuclear missiles.
  const DOME = { tech: 80, rank: 5, cash: 750e6, steel: 12000, goods: 9000, oil: 6000, buildH: 48, upkeep: 1.35e6, mis: .75, nuke: .4,
    // upgrade levels: each one shoots down more missiles and has a better chance against a nuclear missile
    lv: { max: 5, mis: [.75, .8, .85, .89, .92], nuke: [.4, .5, .58, .65, .72], cash: [0, 3e8, 5e8, 8e8, 1.2e9], steel: [0, 4000, 6000, 9000, 12000], goods: [0, 3000, 5000, 7000, 10000], oil: [0, 2000, 3000, 5000, 7000], tech: [80, 85, 90, 95, 100], h: [0, 6, 8, 10, 12] } };
  // running cost, billed straight from the treasury every tick once the dome is built (the boss nation's free dome is exempt)
  const domeUpkeep = (W, n) => n && n.dome && n.dome.ready <= W.now && !(n.ai && n.ai.boss) ? Math.round(DOME.upkeep * (1 + .5 * (domeLvl(n) - 1)) * W.m.upkeep) : 0;
  const domeLvl = n => n && n.dome ? clamp(n.dome.lvl || 1, 1, DOME.lv.max) : 0;
  const domeMis = n => DOME.lv.mis[domeLvl(n) - 1] || DOME.mis, domeNuke = n => DOME.lv.nuke[domeLvl(n) - 1] || DOME.nuke;
  const domeOn = (W, n) => !!(n && n.dome && n.dome.ready <= (W ? W.now : Date.now()) && !n.dome.off && !((n.empT || 0) > (W ? W.now : Date.now())) && (n.cash || 0) >= 0);
  function canDome(W, u) {
    const n = W.A[u]; if (!n) return 'Found a nation first.';
    if (n.dome) return n.dome.ready > W.now ? 'Your Golden Dome is under construction.' : 'Your Golden Dome is already protecting your nation.';
    if ((n.tech || 0) < DOME.tech) return `The Golden Dome requires tech level ${DOME.tech}.`;
    if (!W.cfg.nukeTest && rankOf(n.xp) < DOME.rank) return `The Golden Dome requires the rank of ${RANKS[DOME.rank][1]}.`;
    if (n.cash < DOME.cash || (n.res.steel || 0) < DOME.steel || (n.res.goods || 0) < DOME.goods || (n.res.oil || 0) < DOME.oil) return `The Golden Dome costs ${money(DOME.cash)}, ${num(DOME.steel)} steel, ${num(DOME.goods)} goods and ${num(DOME.oil)} oil.`;
    return null;
  }
  // MUNITIONS: each order is limited by what the factories can turn out in an hour, and the depots only hold so much
  const munLeft = (W, n) => { const q = n.munQ && W.now - n.munQ.t < HOUR ? n.munQ.q : 0; return Math.max(0, MUN.batch(n) - q); };
  const munRoom = n => Math.max(0, MUN.cap(n) - Math.floor((n.res && n.res.mun) || 0));
  function makeMun(W, u, q) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); q = Math.floor(Number(q)); if (!(q > 0)) fail('Enter how many munitions to make.');
    const lf = munLeft(W, n), rm = munRoom(n);
    if (!rm) fail(`Your depots are full (${num(MUN.cap(n))} munitions). Higher tech levels add depot space.`);
    if (!lf) fail(`Your factories are at full output. They can make more in ${fmtT(n.munQ.t + HOUR - W.now)}.`);
    if (q > lf) fail(`Your factories can make ${num(lf)} more munitions this hour.`);
    if (q > rm) fail(`Your depots only have room for ${num(rm)} more munitions.`);
    const c = { cash: q * MUN.cash, steel: q * MUN.steel, oil: q * MUN.oil };
    if (n.cash < c.cash || (n.res.steel || 0) < c.steel || (n.res.oil || 0) < c.oil) fail(`${num(q)} munitions need ${money(c.cash)}, ${num(c.steel)} steel and ${num(c.oil)} oil.`);
    n.cash -= c.cash; n.res.steel -= c.steel; n.res.oil -= c.oil; n.res.mun = (n.res.mun || 0) + q;
    if (!(n.munQ && W.now - n.munQ.t < HOUR)) n.munQ = { t: W.now, q: 0 }; n.munQ.q += q;
    log(n, `Your factories made ${num(q)} munitions.`, W); touch(W, u);
    return { msg: `🎖 ${num(q)} munitions made. Stockpile: ${num(Math.floor(n.res.mun))} of ${num(MUN.cap(n))}.` };
  }
  function buildDome(W, u) {
    const why = canDome(W, u); if (why) fail(why); const n = W.A[u];
    n.cash -= DOME.cash; n.res.steel -= DOME.steel; n.res.goods -= DOME.goods; n.res.oil -= DOME.oil;
    n.dome = { t: W.now, ready: W.now + (W.cfg.nukeTest ? 60e3 : DOME.buildH * HOUR), lvl: 1 }; n.approval = clamp(n.approval + 4, 0, 100);
    news(W, u, `🛡 ${n.name} has begun building a Golden Dome: a missile shield over the whole nation.`);
    log(n, `Construction of your Golden Dome has begun. It will be operational in ${W.cfg.nukeTest ? '1 minute' : DOME.buildH + ' hours'}.`, W); touch(W, u);
    return { msg: `🛡 Golden Dome construction has begun. It will protect your nation in ${W.cfg.nukeTest ? '1 minute' : DOME.buildH + ' hours'}.` };
  }
  function canDomeUp(W, u) {
    const n = W.A[u]; if (!n) return 'Found a nation first.'; if (!n.dome) return 'Build a Golden Dome first.'; if (n.dome.ready > W.now) return 'Your Golden Dome is still being built.';
    const l = domeLvl(n); if (l >= DOME.lv.max) return 'Your Golden Dome is already at the highest level.'; if (n.dome.up) return `Your dome is being upgraded to level ${n.dome.up.lvl}: ${fmtT(n.dome.up.ready - W.now)} left.`;
    const L = DOME.lv; if ((n.tech || 0) < L.tech[l]) return `Level ${l + 1} needs tech level ${L.tech[l]}.`;
    if (n.cash < L.cash[l] || (n.res.steel || 0) < L.steel[l] || (n.res.goods || 0) < L.goods[l] || (n.res.oil || 0) < L.oil[l]) return `Level ${l + 1} costs ${money(L.cash[l])}, ${num(L.steel[l])} steel, ${num(L.goods[l])} goods and ${num(L.oil[l])} oil.`;
    return '';
  }
  function domeUp(W, u) {
    const why = canDomeUp(W, u); if (why) fail(why); const n = W.A[u], l = domeLvl(n), L = DOME.lv;
    n.cash -= L.cash[l]; n.res.steel -= L.steel[l]; n.res.goods -= L.goods[l]; n.res.oil -= L.oil[l];
    n.dome.up = { lvl: l + 1, ready: W.now + (W.cfg.nukeTest ? 60e3 : L.h[l] * HOUR) }; log(n, `Golden Dome upgrade to level ${l + 1} has begun (${money(L.cash[l])}).`, W); touch(W, u);
    return { msg: `🛡 Upgrading your Golden Dome to level ${l + 1}: ready in ${W.cfg.nukeTest ? '1 minute' : L.h[l] + ' hours'}. It keeps protecting you at level ${l} meanwhile, then stops ${Math.round(L.mis[l] * 100)}% of missiles and has a ${Math.round(L.nuke[l] * 100)}% chance against a nuclear missile.` };
  }
  // nuclear test in the open ocean: for nations with a nuclear program but no warhead. Once a week; it pushes aggression to 70 (sanctions, nearly rogue).
  const NTEST = { cash: 5e6, cdD: 7, aggr: 70 };
  const RAD_ = Math.PI / 180;
  const gcDist = (a, b) => { const p1 = a[1] * RAD_, p2 = b[1] * RAD_, dl = (b[0] - a[0]) * RAD_; return Math.acos(Math.max(-1, Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl)))) * 6371; };
  const destPt = (c, brg, km) => { const d = km / 6371, b = brg * RAD_, p1 = c[1] * RAD_, l1 = c[0] * RAD_, p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b)), l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)); return [((l2 / RAD_ + 540) % 360) - 180, p2 / RAD_]; };
  // the server can supply a real coastline test (point -> is it land?); without it, distance from provinces is used
  let landTest = null; const setLandTest = fn => { landTest = fn; };
  const openWater = pt => !landTest || ![0, 60, 120, 180, 240, 300].some(b => landTest(destPt(pt, b, 100))) && !landTest(pt);
  // the open-water point (far from every province, at least 100 km from any coast) closest to the nation's capital, 500 to 2,500 km out
  function oceanSite(W, u, rng) {
    const c = P[W.A[u].cap].c; let best = null;
    for (const km of [500, 800, 1200, 1700, 2500]) {
      for (let i = 0; i < 36; i++) { const pt = destPt(c, i * 10 + (rng ? rng() * 6 : 0), km); if (Math.abs(pt[1]) > 72) continue; let m = 1e9; for (const p of P) { const d = gcDist(pt, p.c); if (d < m) m = d; if (m < (landTest ? 250 : 380)) break; } if (m >= (landTest ? 250 : 380) && openWater(pt) && (!best || m > best.m)) best = { pt, m }; }
      if (best) break;
    }
    return best ? best.pt.map(x => Math.round(x * 100) / 100) : destPt(c, 180, 1500);
  }
  const oceanName = ([lon, lat]) => (lat > 51 && lat < 66 && lon > -95 && lon < -76) ? 'Hudson Bay' : (lat > 36 && lat < 47.5 && lon > 46.5 && lon < 55.5) ? 'Caspian Sea' : (lat > 40.5 && lat < 47 && lon > 27 && lon < 42) ? 'Black Sea' : lat > 66 ? 'Arctic Ocean' : lat < -55 ? 'Southern Ocean' : (lat > 30 && lat < 46 && lon > -6 && lon < 36) ? 'Mediterranean Sea' : (lon > -80 && lon < 20 && !(lat < 10 && lon < -70)) ? 'Atlantic Ocean' : ((lon >= 20 && lon < 120 && lat < 28) || (lon >= 115 && lon < 147 && lat < -30)) ? 'Indian Ocean' : 'Pacific Ocean';
  const inOcean = o => o === 'Hudson Bay' ? 'Hudson Bay' : 'the ' + o;
  function nukeTest(W, u, rng, delay) {
    delay = [0, 5, 10, 15].includes(Number(delay)) ? Number(delay) : 5; // minutes of warning before the 30-second countdown
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    if (!n.nuke) fail('You need a nuclear deterrent before you can test one.');
    if (n.warhead) fail('Your program has moved on to a launchable warhead. Tests are for nations with a nuclear program and no warhead.');
    if (W.m.npt) fail('The Non-proliferation Treaty is in force: nuclear tests are banned until it expires.');
    if (W.m.nonukes) fail('A World Council nuclear weapons ban is in force: no nuclear tests until it expires.');
    const wait = (n.cd && n.cd.ntest || 0) - W.now; if (wait > 0) fail(`Your next nuclear test can be held in ${wait > 48 * HOUR ? Math.ceil(wait / 864e5) + ' days' : fmtT(wait)}.`);
    if (n.ntestAt && n.ntestAt > W.now) fail('Your test is already scheduled.');
    if (n.cash < NTEST.cash) fail(`A nuclear test costs ${money(NTEST.cash)}.`);
    const go = W.now + delay * 60e3;
    n.cash -= NTEST.cash; n.cd = n.cd || {}; n.cd.ntest = W.now + NTEST.cdD * 24 * HOUR; n.ntest = go; n.ntestAt = go;
    n.aggr = Math.max(n.aggr || 0, NTEST.aggr); n.stability = clamp(n.stability + 4, 0, 100); n.approval = clamp(n.approval + 3, 0, 100); rogueCheck(W, u);
    const at = oceanSite(W, u, rng), ocean = oceanName(at);
    news(W, u, delay ? `☢ ${n.name} has announced a nuclear test in ${inOcean(ocean)} in ${delay} minutes. Watch the globe.` : `☢ ${n.name} has begun the countdown to a nuclear test in ${inOcean(ocean)}. Watch the globe.`);
    log(n, `You announced a nuclear test in ${inOcean(ocean)}. The world is alarmed: your aggression is now ${Math.round(n.aggr)} and you are under international sanctions.`, W);
    (W.ntestFx = W.ntestFx || []).push({ id: rid(), by: u, byName: n.name, at, ocean, t: W.now, go, delay });
    touch(W, u);
    return { msg: `${delay ? `Nuclear test scheduled: the world has been warned, and the countdown begins in ${delay} minutes` : 'The countdown has begun'} in ${inOcean(ocean)}. Your aggression is now ${Math.round(n.aggr)}: you are under sanctions, one step from rogue status.` };
  }
  function buildNuke(W, u) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (n.nuke) fail('You already have a nuclear deterrent.');
    if ((n.nukeBan || 0) > W.now) fail(`You dismantled your nuclear program recently. You can start a new one in ${fmtT(n.nukeBan - W.now)}.`);
    if (W.m.npt) fail('The Non-proliferation Treaty is in force. No nation may start a nuclear program until it expires.');
    if ((n.tech || 0) < NUKE.tech) fail(`A nuclear program requires tech level ${NUKE.tech}.`);
    if (!W.cfg.nukeTest && rankOf(n.xp) < NUKE.rank) fail(`A nuclear program requires the rank of ${RANKS[NUKE.rank][1]}.`);
    if (n.cash < NUKE.cash || n.res.steel < NUKE.steel || n.res.oil < NUKE.oil || n.res.goods < NUKE.goods) fail(`Requires ${money(NUKE.cash)}, ${NUKE.steel} steel, ${NUKE.oil} oil and ${NUKE.goods} goods.`);
    n.cash -= NUKE.cash; n.res.steel -= NUKE.steel; n.res.oil -= NUKE.oil; n.res.goods -= NUKE.goods; n.nuke = W.now;
    n.aggr = Math.min(100, (n.aggr || 0) + 40); n.stability = clamp(n.stability + 5, 0, 100); rogueCheck(W, u);
    news(W, u, `☢ ${n.name} has tested a nuclear weapon. The world is on alert.`); log(n, 'Your nuclear deterrent is operational. Your capital can no longer be besieged, but the world will not forget.', W);
    for (const v of Object.keys(W.A)) if (v !== u) note(W, v, 'war', `☢ ${n.name} has tested a nuclear weapon.`);
    gainXP(W, u, 50); touch(W, u); return { msg: 'Your nuclear deterrent is operational.' };
  }
  // admin "nuke test mode": no 24h wait, warheads arm in 1 minute, no 7-day lockout
  const nkT = W => W.cfg.nukeTest ? { holdH: 0, buildH: 1 / 60, cdD: 0 } : WARHEAD;
  function canWarhead(W, u) {
    const n = W.A[u]; if (!n) return 'Found a nation first.';
    if (!n.nuke) return 'You need an operational nuclear deterrent first.';
    if (W.m.npt && !n.warhead) return 'The Non-proliferation Treaty is in force. No warheads may be assembled until it expires.';
    if (measure(W, n, 'inspected') && !n.warhead) return `World Council inspectors are monitoring your program. No new warhead for ${fmtT(n.inspected - W.now)}.`;
    if (n.warhead) return n.warhead.ready > W.now ? `A warhead is already being assembled: ready in ${fmtT(n.warhead.ready - W.now)}.` : 'You already have an armed warhead.';
    if (W.now - n.nuke < nkT(W).holdH * HOUR) return `Your deterrent must be operational for ${nkT(W).holdH} hours first: ${fmtT(nkT(W).holdH * HOUR - (W.now - n.nuke))} left.`;
    if (left(W, n, 'warhead') && !W.cfg.nukeTest) return `After a launch, a new warhead takes time to approve: ${fmtT(left(W, n, 'warhead'))} left.`;
    if ((n.tech || 0) < WARHEAD.tech) return `A launchable warhead requires tech level ${WARHEAD.tech}.`;
    if (!W.cfg.nukeTest && rankOf(n.xp) < WARHEAD.rank) return `A launchable warhead requires the rank of ${RANKS[WARHEAD.rank][1]}.`;
    if (n.cash < WARHEAD.cash || n.res.steel < WARHEAD.steel || n.res.oil < WARHEAD.oil || n.res.goods < WARHEAD.goods) return `Requires ${money(WARHEAD.cash)}, ${num(WARHEAD.steel)} steel, ${num(WARHEAD.oil)} oil and ${num(WARHEAD.goods)} goods.`;
    return null;
  }
  function buildWarhead(W, u) {
    const why = canWarhead(W, u); if (why) fail(why); const n = W.A[u];
    n.cash -= WARHEAD.cash; n.res.steel -= WARHEAD.steel; n.res.oil -= WARHEAD.oil; n.res.goods -= WARHEAD.goods;
    n.warhead = { t: W.now, ready: W.now + nkT(W).buildH * HOUR }; n.aggr = Math.min(100, (n.aggr || 0) + 20); rogueCheck(W, u);
    news(W, u, `☢ Intelligence agencies report that ${n.name} is assembling a launchable nuclear warhead.`);
    log(n, `Warhead assembly has begun. It will be armed in ${fmtT(nkT(W).buildH * HOUR)}.`, W);
    for (const v of Object.keys(W.A)) if (v !== u && !W.A[v].ai) note(W, v, 'war', `☢ ${n.name} is assembling a launchable nuclear warhead. It will be armed in ${fmtT(nkT(W).buildH * HOUR)}.`);
    touch(W, u); return { msg: `Warhead assembly begun — armed in ${fmtT(nkT(W).buildH * HOUR)}.` };
  }
  const warheadReady = (W, n) => !!(n && n.warhead && (n.warhead === 2 || n.warhead.ready <= W.now || (W.cfg.nukeTest && n.warhead.t + 60e3 <= W.now)));
  // was this nation nuked by v in the last 72 hours? (any of its attackers, not only the latest)
  const struckBy = (W, me, v) => !!(me && ((me.nuked && me.nuked.by === v && W.now - me.nuked.t < 72 * HOUR) || ((me.nukedBy || {})[v] && W.now - me.nukedBy[v] < 72 * HOUR)));
  function canLaunch(W, u, v) {
    const me = W.A[u], d = W.A[v]; if (!me) return 'Found a nation first.'; if (!d || v === u) return 'Unknown nation.';
    if (!W.cfg.war) return 'Warfare is currently disabled by the administrators.';
    if (W.m.nonukes) return 'A World Council nuclear weapons ban is in force: no launches until it expires.';
    if (!warheadReady(W, me)) return me.warhead ? `Your warhead is not armed yet: ${fmtT(me.warhead.ready - W.now)} left.` : 'You have no armed warhead.';
    if (!atWar(W, u, v)) return `You are not at war with ${d.name}. Declare war first.`;
    { const cf = ceasefireMsg(W, me, d); if (cf) return cf; }
    const mob = W.m.mobilize * MIN; if (W.now - warSince(W, u, v) < mob) return `Forces are mobilizing — ready in ${fmtT(mob - (W.now - warSince(W, u, v)))}.`;
    if (!d.ai && W.now - d.created < W.cfg.protectH * HOUR) return `${d.name} is under new-nation protection.`;
    if (shieldOn(W, d)) return `${d.name} is rebuilding under international protection for another ${fmtT(d.shield - W.now)}.`;
    // a last resort: only after a full day of war, unless they have already nuked you
    if (!W.cfg.nukeTest && !struckBy(W, me, v) && W.now - warSince(W, u, v) < WARHEAD.warH * HOUR) return `A nuclear strike is a last resort: you must be at war with ${d.name} for ${WARHEAD.warH} hours first (${fmtT(WARHEAD.warH * HOUR - (W.now - warSince(W, u, v)))} left).`;
    // several nations may strike the same country, one after another (each strike adds its own damage)
    return null;
  }
  function detonate(W, u, v, h, retaliation) {
    const me = W.A[u], d = W.A[v], pct = x => Math.round(x * 100);
    // ground zero
    const loss = { pop: Math.round(d.pop * .45), troops: Math.floor((d.troops || 0) * .7), ships: Math.floor((d.ships || 0) * .5), air: Math.floor((d.air || 0) * .6), infra: Math.min(d.infra || 0, 5) };
    d.pop -= loss.pop; d.troops -= loss.troops; d.ships -= loss.ships; d.air -= loss.air; d.infra -= loss.infra; d.gdp = (d.gdp || 0) * .4;
    for (const r in RES) d.res[r] = Math.floor((d.res[r] || 0) * .45);
    d.approval = clamp(d.approval - 35, 0, 100); d.stability = clamp(d.stability - 50, 0, 100); d.health = clamp((d.health || 50) - 35, 0, 100); d.morale = clamp((d.morale || 50) - 35, 0, 100);
    d.nuked = { t: W.now, until: Math.max(W.now + WARHEAD.nukedH * HOUR, d.nuked && d.nuked.until || 0), h: +h, by: u, byName: me.name };
    d.nukedBy = Object.fromEntries(Object.entries({ ...(d.nukedBy || {}), [u]: W.now }).filter(([, t]) => W.now - t < 72 * HOUR));
    // fallout zone and worldwide nuclear winter
    const hit = [];
    for (const x of Object.keys(W.A)) {
      const n = W.A[x]; if (x === v) continue; n.winter = Math.max(n.winter || 0, W.now + WARHEAD.winterH * HOUR); n.health = clamp((n.health || 50) - 3, 0, 100); n.stability = clamp(n.stability - 3, 0, 100);
      const near = hexesOf(W, x).some(k => kmBetween(+k, +h) <= WARHEAD.km);
      if (near) { n.fallout = Math.max(n.fallout || 0, W.now + WARHEAD.falloutH * HOUR); n.pop = Math.round(n.pop * .9); n.health = clamp(n.health - 20, 0, 100); n.approval = clamp(n.approval - 15, 0, 100); n.stability = clamp(n.stability - 8, 0, 100); hit.push(x);
        // the fallout makes them furious: a just cause to fight the launcher for a week (attacking it adds no aggression), and some AI nations go to war over it
        if (x !== u) { n.cb = n.cb || {}; n.cb[u] = Math.max(n.cb[u] || 0, W.now + WARHEAD.angerD * 864e5); n.nukeGrudge = { ...(n.nukeGrudge || {}), [u]: W.now }; }
        note(W, x, 'war', `☢ Radioactive fallout from ${me.name}'s strike on ${d.name} is drifting over your nation: population −10%, health −20, approval −15, tax revenue halved for ${WARHEAD.falloutH} hours. You have a just cause against ${me.name} for ${WARHEAD.angerD} days.`); }
      touch(W, x);
    }
    // the attacker becomes a pariah. A second strike (automatic retaliation, or answering a nation that nuked you in the last 72 hours) is defense, not aggression.
    const secondStrike = retaliation || struckBy(W, me, v);
    me.warhead = null; me.cd.warhead = W.now + nkT(W).cdD * 24 * HOUR;
    // AI nations poisoned by the fallout may declare war on the launcher (unless they are its allies)
    if (!secondStrike) for (const x of hit) { const n = W.A[x]; if (x === u || !n || !n.ai || n.ai.boss || atWar(W, x, u) || allies(W, u).includes(x) || Math.random() >= WARHEAD.aiWar) continue;
      setRel(n, u, 'war', W.now); setRel(n, u, 'unally', W.now); setRel(n, u, 'untrade', W.now); n.rel[u].fair = 1; n.rel[u].def = 1;
      log(n, `${n.name} declared war on ${me.name} after its nuclear fallout poisoned our people.`, W); note(W, u, 'war', `☢ ${n.name} declared war on you: your fallout poisoned its people.`); news(W, x, `${n.name} declared war on ${me.name} after nuclear fallout drifted over its land.`); touch(W, x); }
    if (!secondStrike) {
      me.aggr = 100; me.rogue = Math.max(me.rogue || 0, W.now + 72 * HOUR);
      for (const a of allies(W, u)) { setRel(W.A[a], u, 'unally', W.now); note(W, a, 'diplo', `You ended your alliance with ${me.name} after its nuclear strike.`); touch(W, a); }
    }
    me.approval = clamp(me.approval - (secondStrike ? 5 : me.gov === 'dic' ? 5 : 20), 0, 100);
    const sum = `${num(loss.pop)} people and ${num(loss.troops)} troops killed${loss.infra ? `, ${loss.infra} infrastructure level${loss.infra > 1 ? 's' : ''} destroyed` : ''}, GDP −60%, tax collection halted for ${WARHEAD.nukedH} hours`;
    log(me, `☢ Your nuclear strike on ${pname(h)} (${d.name}): ${sum}. Your nation is now a rogue state for at least 72 hours.`, W);
    log(d, `☢ ${me.name} detonated a nuclear weapon over ${pname(h)}: ${sum}.`, W);
    note(W, v, 'attack', `☢ ${me.name} launched a nuclear strike on ${pname(h)}. ${sum}.`);
    news(W, u, `☢ ${retaliation ? 'RETALIATION — ' : ''}${me.name} has launched a nuclear strike on ${d.name}. ${pname(h)} is in ruins and fallout is spreading.`);
    for (const x of Object.keys(W.A)) if (x !== u && x !== v && !W.A[x].ai && !hit.includes(x)) note(W, x, 'war', `☢ ${me.name} has launched a nuclear strike on ${d.name}. The world enters a nuclear winter for ${WARHEAD.winterH} hours.`);
    aggrHit(W, u, v, 'nuclear strike'); (W.nukeFx = W.nukeFx || []).push({ by: u, byName: me.name, to: v, toName: d.name, from: me.cap, h: +h, place: pname(h), retaliation: !!retaliation, t: W.now });
    touch(W, u, v); return sum;
  }
  // a Golden Dome destroyed the nuclear missile in flight: no detonation, but the warhead is spent and the launch still counts
  function interceptNuke(W, u, v, h, retaliation) {
    const me = W.A[u], d = W.A[v], secondStrike = retaliation || struckBy(W, me, v);
    me.warhead = null; me.cd.warhead = W.now + nkT(W).cdD * 24 * HOUR;
    if (!secondStrike) { me.aggr = 100; me.rogue = Math.max(me.rogue || 0, W.now + 72 * HOUR); for (const a of allies(W, u)) { setRel(W.A[a], u, 'unally', W.now); note(W, a, 'diplo', `You ended your alliance with ${me.name} after it launched a nuclear missile.`); touch(W, a); } }
    me.approval = clamp(me.approval - (secondStrike ? 3 : 12), 0, 100); d.approval = clamp(d.approval + 8, 0, 100); d.stability = clamp(d.stability + 5, 0, 100);
    news(W, u, `☢ ${me.name} launched a nuclear missile at ${d.name}, but ${d.name}'s Golden Dome intercepted it high above ${pname(h)}.`);
    note(W, v, 'attack', `🛡 Your Golden Dome intercepted a nuclear missile launched by ${me.name}!`); log(d, `🛡 Your Golden Dome intercepted a nuclear missile launched by ${me.name} at ${pname(h)}.`, W);
    aggrHit(W, u, v, 'nuclear strike'); (W.nukeFx = W.nukeFx || []).push({ by: u, byName: me.name, to: v, toName: d.name, from: me.cap, h: +h, place: pname(h), retaliation: !!retaliation, intercepted: true, t: W.now });
    touch(W, u, v);
  }
  function launchNuke(W, u, v, h, rng) { dropShield(W.A[u]);
    const why = canLaunch(W, u, v); if (why) fail(why); const d = W.A[v]; const R = rng || Math.random;
    h = h == null || h === '' ? d.cap : Number(h); if (owner(W, h) !== v) fail(`That province does not belong to ${d.name}.`);
    if (domeOn(W, d) && R() < domeNuke(d)) { interceptNuke(W, u, v, h, false); return { msg: `☢ Launch confirmed, but ${d.name}'s Golden Dome intercepted your missile before it could detonate. Your warhead is spent.`, intercepted: true }; }
    const sum = detonate(W, u, v, h, false);
    // mutually assured destruction: an armed warhead fires back automatically (and the attacker's own dome may stop it)
    let mad = '';
    if (warheadReady(W, d) && W.A[u]) { if (domeOn(W, W.A[u]) && R() < domeNuke(W.A[u])) { interceptNuke(W, v, u, W.A[u].cap, true); mad = ` ${d.name} fired back automatically, but your Golden Dome intercepted its missile.`; } else { detonate(W, v, u, W.A[u].cap, true); mad = ` ${d.name} had an armed warhead and retaliated automatically against your capital.`; } }
    return { msg: `☢ Detonation confirmed — ${sum}.${mad}`, nuked: { h, sum, mad: !!mad } };
  }
  // collective defense: a pact member goes to war with whoever attacked a fellow member (fair war: the aggressor started it)
  function pactWar(W, m, aggr, victim) {
    const me = W.A[m], them = W.A[aggr], vic = W.A[victim]; if (!me || !them || !vic || m === aggr || atWar(W, m, aggr)) return false;
    const t = W.now; setRel(me, aggr, 'war', t); setRel(me, aggr, 'unally', t); setRel(me, aggr, 'untrade', t); me.rel[aggr].fair = 1; me.rel[aggr].def = 1;
    log(me, `Under the Collective Defense Pact you are now at war with ${them.name}, which attacked ${vic.name}.`, W); log(them, `${me.name} declared war on you under a Collective Defense Pact after your attack on ${vic.name}.`, W);
    note(W, m, 'war', `Collective Defense Pact: ${them.name} attacked ${vic.name}. You are now at war with ${them.name}.`); note(W, aggr, 'war', `${me.name} has declared war on you under a Collective Defense Pact.`);
    touch(W, m, aggr); return true;
  }
  function dip(W, u, kind, v) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const t = W.now;
    if (kind === 'war') {
      if (!W.cfg.war) fail('Warfare is currently disabled by the administrators.');
      if (them.overlord === u) fail(`${them.name} is your vassal. Release it first.`); if (me.overlord === v) fail(`You are ${them.name}'s vassal. Declare independence instead.`);
      if (rankOf(me.xp) < 2) fail('You must reach the rank of Mayor to declare war.');
      if (atWar(W, u, v)) fail('You are already at war.');
      if (W.m.truce) fail('A World Council truce is in force: no new wars may be declared until it ends.');
      if (sameBloc(W, u, v)) fail(`${them.name} is in your alliance. Leave the alliance or remove them before declaring war.`);
      breakRoute(W, u, v, 'war'); setRel(me, v, 'war', t); setRel(me, v, 'unally', t); setRel(me, v, 'untrade', t); me.rel[v].fair = score(W, v) >= score(W, u) * .4 ? 1 : 0;
      news(W, u, `${me.name} has declared war on ${them.name}.`); log(them, `${me.name} has declared war on you.`, W); note(W, v, 'war', `${me.name} has declared war on you!`);
      if (W.cfg.conquest && !them.ai && Object.keys(them.hexes || {}).length === 1) { const hrs = W.cfg.lastStandH ?? 24; log(them, `You hold only your capital. ${me.name} can besiege it in ${hrs} hours — make peace, rally allies, fortify or expand.`, W); note(W, v, 'attack', `LAST STAND: ${me.name} can besiege your capital in ${hrs} hours.`); }
    } else if (kind === 'noally' || kind === 'notrade' || kind === 'nopeace') {
      // decline a proposal another nation made to you
      const what = kind.slice(2), R_ = R(W, v, u);
      if (what === 'peace') { if (!atWar(W, u, v) || !((R_.peace || 0) > warSince(W, u, v))) fail('There is no peace offer to decline.'); setRel(them, u, 'peace', 0); }
      else { if (!offered(W, v, u, what)) fail(`There is no ${what === 'ally' ? 'alliance' : 'trade'} proposal to decline.`); setRel(me, v, 'un' + what, t); }
      const label = { ally: 'alliance proposal', trade: 'trade agreement', peace: 'peace offer' }[what];
      note(W, v, 'diplo', `${me.name} declined your ${label}.`); log(me, `Declined ${them.name}'s ${label}.`, W); log(them, `${me.name} declined your ${label}.`, W);
      touch(W, u, v); return { msg: `You declined ${them.name}'s ${label}.` };
    } else if (kind === 'peace') {
      if (!atWar(W, u, v)) fail('You are not at war with them.');
      if ((R(W, u, v).peace || 0) > warSince(W, u, v)) fail(`You have already offered peace to ${them.name}. Waiting for their answer.`);
      setRel(me, v, 'peace', t);
      if (!atWar(W, u, v)) { news(W, u, `${me.name} and ${them.name} signed a peace treaty.`); note(W, v, 'diplo', `${me.name} accepted peace. The war is over.`); }
      else { log(me, `Peace offered to ${them.name}.`, W); log(them, `${me.name} is offering peace.`, W); note(W, v, 'diplo', `${me.name} is offering peace.`); }
    } else if (kind === 'ally') {
      if (atWar(W, u, v)) fail('Make peace first.');
      if (pact(W, u, v, 'ally')) fail(`You are already allied with ${them.name}.`);
      if (rogue(W, me) !== rogue(W, them)) fail(rogue(W, me) ? 'No nation will ally with a rogue state.' : `${them.name} is a rogue state. No alliance is possible.`);
      if (offered(W, u, v, 'ally')) fail(`You have already proposed an alliance to ${them.name}. Waiting for their answer.`);
      setRel(me, v, 'ally', t);
      if (pact(W, u, v, 'ally')) { news(W, u, `${me.name} and ${them.name} formed an alliance.`); note(W, v, 'diplo', `${me.name} accepted your alliance.`); note(W, u, 'diplo', `Alliance with ${them.name} formed.`); }
      else { log(me, `Alliance proposed to ${them.name}.`, W); log(them, `${me.name} proposes an alliance.`, W); note(W, v, 'diplo', `${me.name} proposes an alliance.`); }
    } else if (kind === 'unally') { if (!pact(W, u, v, 'ally') && !offered(W, u, v, 'ally')) fail('There is no alliance to end.'); setRel(me, v, 'unally', t); news(W, u, `${me.name} ended its alliance with ${them.name}.`); note(W, v, 'diplo', `${me.name} ended your alliance.`); }
    else if (kind === 'trade') {
      if (atWar(W, u, v)) fail('Make peace first.');
      if (sanctioned(me)) fail('No nation will sign trade agreements with you while you are under sanctions.');
      if (rogue(W, me) || rogue(W, them)) fail(rogue(W, me) ? 'No nation will trade with a rogue state.' : `${them.name} is a rogue state under international embargo.`);
      if (embargoed(W, me)) fail('You are under a World Council embargo.');
      if (pact(W, u, v, 'trade')) fail(`You already have a trade agreement with ${them.name}.`);
      if (offered(W, u, v, 'trade')) fail(`You have already proposed a trade agreement to ${them.name}. Waiting for their answer.`);
      if (pact(W, u, v, 'ally')) fail(`You are allies with ${them.name}, so you already trade automatically.`);
      setRel(me, v, 'trade', t);
      if (pact(W, u, v, 'trade')) { news(W, u, `${me.name} and ${them.name} signed a trade agreement.`); note(W, v, 'diplo', `${me.name} accepted your trade agreement.`); note(W, u, 'diplo', `Trade agreement with ${them.name} signed.`); }
      else { log(me, `Trade agreement proposed to ${them.name}.`, W); log(them, `${me.name} proposes a trade agreement.`, W); note(W, v, 'diplo', `${me.name} proposes a trade agreement.`); }
    } else if (kind === 'untrade') { if (!pact(W, u, v, 'trade') && !offered(W, u, v, 'trade')) fail('There is no trade agreement to cancel.'); breakRoute(W, u, v, 'cancel'); setRel(me, v, 'untrade', t); log(me, `Trade agreement with ${them.name} cancelled.`, W); log(them, `${me.name} cancelled your trade agreement.`, W); note(W, v, 'diplo', `${me.name} cancelled your trade agreement.`); }
    else fail('Unknown action.');
    touch(W, u, v); return { msg: 'Done.' };
  }

  function aid(W, u, v, amt) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Unknown nation.');
    const a = { cash: Math.max(0, Math.floor(Number(amt.cash) || 0)) }; for (const r in RES) a[r] = Math.max(0, Math.floor(Number(amt[r]) || 0));
    if (rogue(W, me)) fail('Rogue states cannot send aid.'); if (rogue(W, them)) fail(`${them.name} is a rogue state under international embargo. Aid is not allowed.`);
    if (a.cash > 1e13 || Object.keys(RES).some(r => a[r] > 1e9)) fail('Amount too large.');
    if (!a.cash && !Object.keys(RES).some(r => a[r])) fail('Enter an amount.');
    if (a.cash > me.cash) fail('Insufficient funds.'); for (const r in RES) if (a[r] > me.res[r]) fail('Not enough ' + r + '.');
    me.cash -= a.cash; them.cash += a.cash; for (const r in RES) { me.res[r] -= a[r]; them.res[r] += a[r]; }
    const txt = [a.cash ? money(a.cash) : '', ...Object.keys(RES).filter(r => a[r]).map(r => `${num(a[r])} ${rName(r)}`)].filter(Boolean).join(', ');
    pushOut(W, u, { type: 'aid', to: v, ...a }); log(them, `${me.name} sent you aid: ${txt}.`, W); note(W, v, 'diplo', `${me.name} sent you aid: ${txt}.`); news(W, u, `${me.name} sent aid to ${them.name}.`);
    // XP only for real help: aid worth at least $1M, and once per receiving nation per hour (so $1 gifts can't be spammed for rank)
    { const val = a.cash + Object.keys(RES).reduce((t, r) => t + a[r] * RES[r].p, 0); if (val >= 1e6) xpOnce(W, u, 'aid_' + v, HOUR, 5); }
    touch(W, u, v); return { msg: `Aid sent: ${txt}.`, amount: a };
  }

  function market(W, u, r, q, buy) {
    const me = W.A[u]; if (!me) fail('Found a nation first.'); if (!has(RES, r)) fail('Unknown commodity.');
    if (embargoed(W, me)) fail('You are under a World Council embargo and cannot trade on the world market.');
    if ((me.blockade || 0) > W.now) fail(`Enemy warships are blockading your ports: no market trade for ${fmtT(me.blockade - W.now)}.`);
    if (rogue(W, me)) fail('Your nation is a rogue state under a full international embargo. The world market is closed to you.');
    q = Math.floor(Number(q)); if (!(q > 0) || q > 1e6) fail('Enter a valid quantity.');
    const s = spreads(W, u), base = RES[r].p * (W.m.price[r] || 1); let msg;
    if (buy && r === 'mun' && q > munRoom(me)) fail(munRoom(me) ? `Your depots only have room for ${num(munRoom(me))} more munitions.` : `Your depots are full (${num(MUN.cap(me))} munitions).`);
    if (buy) { const cost = Math.round(base * orderMult(W, u, r, q) * s.buy * q); if (cost > me.cash) fail(`That order costs ${money(cost)}.`); me.cash -= cost; me.res[r] += q; me.imp = (me.imp || 0) + cost; me.trades = [{ t: W.now, r, q }, ...(me.trades || [])].slice(0, 40); msg = `Imported ${num(q)} ${rName(r)} for ${money(cost)}.`; }
    else { if (q > me.res[r]) fail('You do not have that much.'); const got = Math.round(base * orderMult(W, u, r, -q) * s.sell * q); me.cash += got; me.rev = (me.rev || 0) + got; me.res[r] -= q; me.exp = (me.exp || 0) + got; me.trades = [{ t: W.now, r, q: -q }, ...(me.trades || [])].slice(0, 40); msg = `Exported ${num(q)} ${rName(r)} for ${money(got)}.`; }
    log(me, msg, W); if (base * q >= 1e5) xpOnce(W, u, 'mkt', 5 * MIN, 2); touch(W, u); return { msg };
  }

  // AUTO-BUY ORDERS: "when my food falls below X, buy Y on the world market", checked every 10 minutes, online or not.
  // An order only fills when the nation can pay for it outright (it never borrows), at the normal market price and fees,
  // and never above the leader's optional price limit. Munitions only fill up to the free depot space.
  const AUTOBUY = { maxQ: 1e6, maxBelow: 1e8, everyMs: TICK, warnH: 6 };
  function setAutoBuy(W, u, c) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const r = String(c.r || ''); if (!has(RES, r)) fail('Unknown commodity.');
    n.auto = n.auto || {};
    if (c.off) { delete n.auto[r]; touch(W, u); return { msg: `Auto-buy for ${rName(r)} switched off.` }; }
    const below = Math.floor(Number(c.below)), q = Math.floor(Number(c.q)), maxp = c.maxp === '' || c.maxp == null ? 0 : Math.round(Number(c.maxp));
    if (!(below > 0) || below > AUTOBUY.maxBelow) fail('Enter the level to buy at (more than 0).');
    if (!(q > 0) || q > AUTOBUY.maxQ) fail(`Enter how much to buy each time (1 to ${num(AUTOBUY.maxQ)}).`);
    if (!(maxp >= 0) || maxp > 1e7) fail('Enter a sensible price limit, or leave it empty.');
    n.auto[r] = { below, q, maxp, t: W.now }; touch(W, u);
    return { msg: `Auto-buy set: when ${rName(r)} falls below ${num(below)}, buy ${num(q)}${maxp ? ` (at most ${money(maxp)} each)` : ''}.` };
  }
  const autoUnit = (W, u, r, q) => { const s = spreads(W, u); return RES[r].p * (W.m.price[r] || 1) * orderMult(W, u, r, q) * s.buy; };
  function autoBuyTick(W, u) {
    const n = W.A[u]; if (!n || !n.auto || n.ai) return false; const ks = Object.keys(n.auto).filter(r => has(RES, r)); if (!ks.length) return false;
    if (n.autoT && W.now - n.autoT < AUTOBUY.everyMs) return false; n.autoT = W.now; let ch = false;
    for (const r of ks) {
      const o = n.auto[r]; if ((n.res[r] || 0) >= o.below) continue;
      let q = o.q; if (r === 'mun') q = Math.min(q, munRoom(n));
      const why = q <= 0 ? 'your depots are full' : embargoed(W, n) ? 'a World Council embargo closes the world market to you' : (n.blockade || 0) > W.now ? 'enemy warships are blockading your ports' : rogue(W, n) ? 'rogue states are shut out of the world market' : null;
      let cost = 0, unit = 0; if (!why) { unit = autoUnit(W, u, r, q); cost = Math.round(unit * q); }
      const why2 = why || (o.maxp && unit > o.maxp ? `the price (${money(Math.round(unit))} each) is above your limit of ${money(o.maxp)}` : cost > Math.max(0, n.cash) ? `you need ${money(cost)} and have ${money(Math.max(0, Math.floor(n.cash)))}` : null);
      if (why2) { o.fail = why2; o.failT = W.now; if (!o.warnT || W.now - o.warnT > AUTOBUY.warnH * HOUR) { o.warnT = W.now; note(W, u, 'economy', `🛒 Auto-buy couldn't restock ${rName(r)}: ${why2}.`); log(n, `Auto-buy skipped for ${rName(r)}: ${why2}.`, W); } ch = true; continue; }
      n.cash -= cost; n.res[r] = (n.res[r] || 0) + q; n.imp = (n.imp || 0) + cost; n.trades = [{ t: W.now, r, q }, ...(n.trades || [])].slice(0, 40);
      o.last = { t: W.now, q, cost }; delete o.fail; delete o.warnT;
      log(n, `🛒 Auto-buy: imported ${num(q)} ${rName(r)} for ${money(cost)} (stock had fallen below ${num(o.below)}).`, W); ch = true;
    }
    if (ch) touch(W, u); return ch;
  }
  function setTax(W, u, t) { const n = W.A[u]; if (!n) fail('Found a nation first.'); t = Math.round(Number(t)); if (!(t >= 5 && t <= 50)) fail('Tax must be between 5% and 50%.'); n.tax = t; touch(W, u); return { msg: `Tax rate set to ${t}%.` }; }
  function setBudget(W, u, b) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    const spend = Math.round(Number(b.spend)); if (!(spend >= 5 && spend <= 40)) fail('Government spending must be between 5% and 40% of GDP.');
    const parts = ['mil', 'health', 'edu', 'infra'].map(k => Math.max(0, Number(b[k]) || 0)); const sum = parts.reduce((a, c) => a + c, 0); if (!(sum > 0)) fail('Allocate the budget.');
    const nb = { spend }; ['mil', 'health', 'edu', 'infra'].forEach((k, i) => nb[k] = Math.round(parts[i] / sum * 1000) / 10);
    n.budget = nb; touch(W, u); return { msg: 'Budget approved.' };
  }
  function bonds(W, u, amt, repay) {
    const n = W.A[u]; if (!n) fail('Found a nation first.');
    amt = Math.floor(Number(amt)); if (!(amt > 0) || amt > 1e13) fail('Enter an amount.');
    if (repay) { if (!(n.debt > 0)) fail('You have no debt to repay.'); if (amt > n.debt) amt = n.debt; if (amt > n.cash) fail('You do not have that much cash.'); n.cash -= amt; n.debt -= amt; if (n.debt < 1) n.debt = 0; /* no leftover cents that can never be repaid */ log(n, `Repaid ${money(amt)} of national debt.`, W); touch(W, u); return { msg: `Repaid ${money(amt)}. Debt is now ${moneyS(n.debt)}.` }; }
    if ((n.defaulted || 0) > W.now - 48 * HOUR) fail('No one will lend to you for 48 hours after a default.');
    if (amt > maxBorrow(n)) fail(`Lenders will only lend up to ${money(maxBorrow(n))} more (120% of GDP in total).`);
    n.cash += amt; n.debt += amt; n.infl = clamp(n.infl + amt / Math.max(1, n.gdp) * 4, -2, 80);
    log(n, `Issued ${money(amt)} in government bonds at ${interestRate(W, n).toFixed(1)}% interest.`, W); touch(W, u);
    return { msg: `Bonds issued: +${money(amt)}. Interest rate ${interestRate(W, n).toFixed(1)}% per year.` };
  }
  function setGov(W, u, g) { const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(GOV, g)) fail('Unknown government.'); if (g === n.gov) fail('That is already your government.'); if (left(W, n, 'gov')) fail(`Your government can change again in ${fmtT(left(W, n, 'gov'))}.`); n.gov = g; n.stability = clamp(n.stability - 25, 0, 100); n.approval = clamp(n.approval - 10, 0, 100); n.cd.gov = W.now + 6 * HOUR; n.nextElection = g === 'dem' ? W.now + W.cfg.electionH * HOUR : 0; n.campaign = 0; n.rig = 0; news(W, u, `${n.name} is now a ${GOV[g].n}.`); touch(W, u); return { msg: `You now govern a ${GOV[g].n}.` }; }

  function covert(W, u, op, v, rng) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them) fail('Unknown nation.');
    if (!has(COVERT, op)) fail('Unknown operation.'); const o = COVERT[op];
    if (v === u && op !== 'rig') fail('You cannot target yourself with that operation.');
    if (op === 'rig' && them.gov !== 'dem') fail('That nation does not hold elections.');
    if (op === 'rebellion' && hexesOf(W, v).length < 3) fail('Separatists need a nation with at least 3 provinces.');
    if (op === 'assassinate' && !(them.gens || []).length) fail(`${them.name} has no generals to target.`);
    if (op === 'defect' && !(them.spies > 0)) fail(`${them.name} has no agents to turn.`);
    if (left(W, me, 'covert')) fail(`Your agents are still on assignment: ${fmtT(left(W, me, 'covert'))}.`);
    if (me.spies < o.spies) fail(`This operation needs ${o.spies} agents. You have ${me.spies}.`);
    if (me.cash < o.cost) fail(`This operation costs ${money(o.cost)}.`);
    me.cash -= o.cost; me.cd.covert = W.now + 20 * MIN;
    const self = v === u;
    const p = self ? .7 : clamp(.5 + (me.spies - (them.spies || 0) * .6) * .03 + (me.tech - them.tech) * .02 - them.fort * .01 + ((them.laws || []).includes('censorship') ? .1 : 0), .1, .9);
    const ok = rng() < (op === 'assassinate' ? p * .7 : p); let msg; // assassinations are harder to pull off
    if (ok) {
      if (op === 'steal') { if (them.tech > me.tech) { me.tech++; msg = `Your agents stole research from ${them.name}. Tech level ${me.tech}.`; } else { me.cash += o.cost * .5; msg = `Your agents infiltrated ${them.name} but found nothing more advanced than your own research.`; } log(them, 'Security services suspect a data breach at a research institute.', W); }
      else if (op === 'sabotage') { for (const r in RES) them.res[r] = Math.round(them.res[r] * .8); if (them.infra > 0 && rng() < .5) them.infra--; msg = `Sabotage in ${them.name} succeeded: stockpiles destroyed${them.infra >= 0 ? ' and infrastructure damaged' : ''}.`; log(them, 'Explosions at industrial sites destroyed supplies. The culprits are unknown.', W); note(W, v, 'covert', 'Sabotage hit your industry. The culprits are unknown.'); }
      else if (op === 'unrest') { them.stability = clamp(them.stability - 10, 0, 100); them.approval = clamp(them.approval - 5, 0, 100); msg = `Protests have broken out across ${them.name}.`; log(them, 'Mysteriously well-funded protests have broken out.', W); }
      else if (op === 'rebellion') { const hs = hexesOf(W, v).filter(h => h != them.cap).sort((a, b) => P[them.cap] ? kmBetween(b, them.cap) - kmBetween(a, them.cap) : 0), h = hs[0]; them.unrest = them.unrest || {}; them.unrest[h] = W.now + 24 * HOUR; msg = `Your agents are arming separatists in ${pname(h)}. For 24 hours it may declare independence from ${them.name}.`; log(them, `Separatist unrest has flared up in ${pname(h)}. Raise stability or garrison it to keep it.`, W); note(W, v, 'covert', `⚠ Armed separatists are active in ${pname(h)}. It may break away within 24 hours unless your stability is high.`); }
      else if (op === 'fakenews') { them.approval = clamp(them.approval - 8, 0, 100); them.stability = clamp(them.stability - 4, 0, 100); them.aggr = clamp((them.aggr || 0) + 8, 0, 100); msg = `Fake news is spreading through ${them.name}: its government is reeling and the world now sees it as more aggressive.`; log(them, 'A wave of fake news has hit your nation: approval −8, stability −4, aggression +8.', W); note(W, v, 'covert', 'A fake-news campaign hit your nation. The source is unknown.'); }
      else if (op === 'siphon') { const a = Math.round(Math.min(5e7, Math.max(0, them.cash) * .02)); them.cash -= a; me.cash += a; msg = `Your agents siphoned ${money(a)} out of ${them.name}'s treasury.`; log(them, `Auditors found ${money(a)} missing from the treasury.`, W); note(W, v, 'covert', `${money(a)} vanished from your treasury. Foreign agents are suspected.`); }
      else if (op === 'assassinate') { const g = them.gens.reduce((b, x) => !b || x.stars > b.stars ? x : b, null); them.gens = them.gens.filter(x => x !== g); them.morale = clamp((them.morale || 50) - 10, 0, 100); them.stability = clamp(them.stability - 5, 0, 100);
        const role = (GEN_TYPES[g.type] || {}).n || 'general'; msg = `Your agents assassinated ${g.name}, ${them.name}'s ${g.stars}-star ${role.toLowerCase()}.`; gainXP(W, u, 25);
        log(them, `☠ ${g.name}, your ${g.stars}-star ${role.toLowerCase()}, was assassinated. Morale −10, stability −5. The killers escaped.`, W); note(W, v, 'covert', `☠ ${g.name}, your ${g.stars}-star ${role.toLowerCase()}, was assassinated by unknown agents.`); news(W, v, `☠ ${them.name}'s general ${g.name} has been assassinated. No one has claimed responsibility.`); }
      else if (op === 'recon') { const g = (them.gens || []).length, wp = [them.nuke && 'a nuclear deterrent', them.warhead && 'a warhead', them.dome && `a level ${domeLvl(them)} Golden Dome`].filter(Boolean);
        msg = `🛰 Intelligence report on ${them.name}: treasury ${money(them.cash || 0)}, army ${num(them.troops || 0)}, ${num(them.ships || 0)} warships, ${num(them.air || 0)} aircraft, ${num(them.spies || 0)} agents, tech level ${them.tech || 0}, fortifications ${them.fort || 0}, ${g} general${g === 1 ? '' : 's'}${wp.length ? `, and ${wp.join(', ')}` : ''}. Morale ${Math.round(them.morale || 0)}%, stability ${Math.round(them.stability || 0)}%.`;
        me.intel = me.intel || {}; me.intel[v] = { t: W.now, cash: Math.round(them.cash || 0), troops: them.troops || 0, ships: them.ships || 0, air: them.air || 0, spies: them.spies || 0, tech: them.tech || 0 }; }
      else if (op === 'blackout') { penalty(W, them, { prod: .6, gdp: .97 }, 8); them.stability = clamp(them.stability - 3, 0, 100); msg = `The lights went out across ${them.name}: production −40% and GDP −3% for 8 hours.`; log(them, '⚡ A nationwide blackout has crippled your factories: production −40% and GDP −3% for 8 hours. Saboteurs are suspected.', W); note(W, v, 'covert', '⚡ Saboteurs knocked out your power grid: production −40% for 8 hours.'); }
      else if (op === 'crash') { them.gdp = (them.gdp || 0) * .96; penalty(W, them, { tax: .8 }, 8); them.approval = clamp(them.approval - 3, 0, 100); msg = `Panic selling hit ${them.name}'s markets: GDP −4% and tax revenue −20% for 8 hours.`; log(them, '📉 Your stock market crashed after a wave of panic selling: GDP −4%, tax revenue −20% for 8 hours. Foreign agents may be behind it.', W); note(W, v, 'covert', '📉 Your stock market crashed: GDP −4% and tax revenue −20% for 8 hours.'); news(W, v, `📉 ${them.name}'s stock market has crashed.`); }
      else if (op === 'defect') { const l = Math.min(2, them.spies || 0); them.spies -= l; me.spies = (me.spies || 0) + 1; msg = `One of ${them.name}'s agents now works for you, and exposed another: they lost ${l} agent${l === 1 ? '' : 's'}, you gained 1.`; log(them, `Counter-intelligence reports ${l} of your agents have gone missing.`, W); }
      else if (op === 'poison') { const f = Math.floor((them.res.food || 0) / 3); them.res.food -= f; them.health = clamp((them.health || 50) - 6, 0, 100); them.approval = clamp(them.approval - 2, 0, 100); msg = `Your agents spoiled ${num(f)} food in ${them.name}'s warehouses.`; log(them, `☣ ${num(f)} food was found contaminated and destroyed. Health −6.`, W); note(W, v, 'covert', `☣ ${num(f)} of your food stockpile was contaminated and destroyed.`); }
      else if (op === 'rig') { them.rig = (them.rig || 0) + (self ? 8 : -10); msg = self ? 'Your agents quietly secured votes for the next election (+8%).' : `Your agents are swinging ${them.name}'s next election against its government.`; }
    } else {
      const caught = rng() < (op === 'assassinate' ? .85 : .7); const lost = Math.ceil(o.spies / 2); me.spies -= lost;
      if (caught && !self) {
        me.aggr = clamp((me.aggr || 0) + 10, 0, 100); setRel(me, v, 'unally', W.now);
        news(W, u, `Agents working for ${me.name} were caught attempting to ${o.n.toLowerCase()} in ${them.name}.`); them.cb = them.cb || {}; const cbH = op === 'assassinate' ? 48 : 24; them.cb[u] = Math.max(them.cb[u] || 0, W.now + cbH * HOUR); if (op === 'assassinate') me.aggr = clamp((me.aggr || 0) + 10, 0, 100); note(W, v, 'covert', `You have a just cause against ${me.name} for ${cbH} hours: attacking it adds no aggression.`);
        log(them, `Your counter-intelligence caught agents from ${me.name} attempting to ${o.n.toLowerCase()}.`, W); note(W, v, 'covert', `Agents from ${me.name} were caught attempting to ${o.n.toLowerCase()} in your nation!`);
        msg = `The operation failed and your agents were caught. ${lost} agents lost; the world now knows.`;
      } else if (caught && self) { me.approval = clamp(me.approval - 10, 0, 100); news(W, u, `Election fraud scandal: ${me.name}'s government was caught rigging its own election.`); msg = 'Your vote-rigging was exposed! Approval −10.'; }
      else msg = `The operation failed, but your agents escaped undetected. ${lost} agents lost.`;
    }
    log(me, msg, W); gainXP(W, u, 10); touch(W, u, v); return { msg, ok };
  }



  // OUTPOSTS: up to 4 staging grounds. Turn your own land into one, or set one up on unclaimed land anywhere.
  const outpostCost = (W, u, h) => owner(W, h) === u ? OUTPOST.conv : OUTPOST.est;
  function outpostCheck(W, u, h) {
    const n = W.A[u]; if (!n) return 'Found a nation first.'; if (!P[h]) return 'Unknown province.'; if (rankOf(n.xp) < OUTPOST.rank) return `Outposts require the rank of ${RANKS[OUTPOST.rank][1]}.`;
    const o = n.outposts || {}; if (o[h]) return 'There is already an outpost here.'; if (Object.keys(o).length >= OUTPOST.max) return `You already have ${OUTPOST.max} outposts. Dismantle one first.`;
    if (h == n.cap) return 'Your capital is already your headquarters.'; const ow = owner(W, h); if (ow && ow !== u) return 'That province belongs to another nation.';
    if (!ow) { const a = adminState(W, u); if (isFinite(a.cap) && a.used + 1 > a.cap) return `Not enough administration for an outpost (${a.used} of ${a.cap} used; an outpost needs 1).`; }
    if (left(W, n, 'outpost')) return `Your engineers are still building: ${fmtT(left(W, n, 'outpost'))}.`;
    const c = outpostCost(W, u, h); if (n.cash < c.cash || (n.res.steel || 0) < c.steel || (n.res.oil || 0) < c.oil) return `${ow ? 'Converting this province' : 'A new outpost'} costs ${money(c.cash)}, ${num(c.steel)} steel and ${num(c.oil)} oil.`;
    return null;
  }
  function buildOutpost(W, u, h) {
    h = Number(h); const why = outpostCheck(W, u, h); if (why) fail(why); const n = W.A[u], c = outpostCost(W, u, h), fresh = !owner(W, h);
    n.cash -= c.cash; n.res.steel -= c.steel; n.res.oil -= c.oil; if (fresh) { n.hexes[h] = W.now; W.OWN = computeOwn(W.A); }
    n.outposts = { ...(n.outposts || {}), [h]: W.now }; n.cd.outpost = W.now + OUTPOST.cdH * HOUR; gainXP(W, u, 20);
    log(n, `🏰 Outpost established at ${pname(h)}: attacks within ${num(OUTPOST.stageKm)} km launch from here, and it and your neighbouring provinces defend 10% better.`, W);
    if (fresh) news(W, u, `🏰 ${n.name} has established an outpost at ${pname(h)}.`); touch(W, u);
    return { msg: `🏰 Outpost established at ${pname(h)}.` };
  }
  function dropOutpost(W, u, h) { const n = W.A[u]; if (!n || !n.outposts || !n.outposts[h]) fail('There is no outpost there.'); const o = { ...n.outposts }; delete o[h]; n.outposts = o; log(n, `Outpost at ${pname(h)} dismantled.`, W); touch(W, u); return { msg: `Outpost at ${pname(h)} dismantled. The province stays yours.` }; }
  function outpostTidy(W, u) { const n = W.A[u]; if (!n || !n.outposts) return false; let ch = false; const o = { ...n.outposts }; for (const h of Object.keys(o)) if (owner(W, +h) !== u) { delete o[h]; ch = true; log(n, `Your outpost at ${pname(+h)} was lost.`, W); } if (ch) { n.outposts = o; touch(W, u); } return ch; }
  // ---------- WORLD CASINO: games of chance with the nation's treasury (all randomness on the server) ----------
  const CASINO = { min: 1e4, maxAbs: 1e9, perMin: 30,
    slots: { sym: ['cherry', 'bar', 'bell', 'star', 'diamond', 'seven'], name: ['Cherry', 'Bar', 'Bell', 'Star', 'Diamond', 'Seven'], w: [34, 26, 18, 12, 7, 3], three: [5, 10, 20, 40, 100, 300], two: { cherry: 1.5 } },
    dice: { hl: 2.25, seven: 5.6 }, reds: [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36] };
  const casinoMax = n => Math.max(CASINO.min, Math.min(CASINO.maxAbs, Math.floor(Math.max(0, n.cash || 0)))); // one table limit for every game: $1B, or what you have
  const cardOf = r => { const v = 1 + Math.floor(r() * 13), s = '♠♥♦♣'[Math.floor(r() * 4)]; return { v, s }; }; // an endless shoe: no deck to count, nothing hidden to peek at
  const bjVal = cs => { let t = 0, a = 0; for (const c of cs) { const x = c.v > 10 ? 10 : c.v; t += x; if (x === 1) a++; } while (a > 0 && t + 10 <= 21) { t += 10; a--; } return t; };
  function casinoBet(W, n, bet) {
    const b = Math.floor(Number(bet)); if (!Number.isFinite(b) || b < CASINO.min) fail(`The minimum bet is ${money(CASINO.min)}.`);
    const mx = casinoMax(n); if (b > mx) fail(`The table limit is ${money(mx)}${mx < CASINO.maxAbs ? ' (what you have in your treasury)' : ''}.`);
    if ((n.cash || 0) < b) fail('You do not have that much money.');
    const cs = n.casino = n.casino || { played: 0, wagered: 0, net: 0, best: 0, hist: [] }; cs.win = (cs.win || []).filter(t => W.now - t < 60e3);
    if (cs.win.length >= CASINO.perMin) fail('The croupier needs a moment. Try again in a few seconds.'); cs.win.push(W.now); return b;
  }
  function casinoSettle(W, u, game, bet, pay, detail, nz) { // pay = total returned to the player (0 = lost the bet)
    const n = W.A[u], cs = n.casino, net = pay - bet; nz = nz || (W.fairNonce != null ? [W.fairNonce] : null); n.cash += net; cs.played++; cs.wagered += bet; cs.net += net; if (net > cs.best) cs.best = net; (W.casinoEv = W.casinoEv || []).push({ u, g: game, bet, net, d: detail, t: W.now });
    cs.hist = [{ t: W.now, g: game, bet, net, d: detail, nz: nz || undefined, fh: W.fairHash ? W.fairHash.slice(0, 16) : undefined }, ...(cs.hist || [])].slice(0, 12);
    if (net >= 5e6 && (game === 'slots' || net >= 2e7)) news(W, u, `🎰 ${n.name} just won ${moneyS(net)} at the World Casino (${({ bj: 'blackjack', roulette: 'roulette', slots: 'slots', dice: 'high-low dice' })[game]}).`);
    touch(W, u); return net;
  }
  function casino(W, u, c, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const R = rng || Math.random, g = String(c.g || '');
    if (g === 'bj') {
      const a = String(c.a || 'deal');
      if (a === 'deal') { if (n.bj) fail('Finish your current hand first.'); const bet = casinoBet(W, n, c.bet); n.cash -= bet; n.bj = { bet, p: [cardOf(R), cardOf(R)], d: [cardOf(R)], t: W.now, nz: W.fairNonce != null ? [W.fairNonce] : undefined };
        if (bjVal(n.bj.p) === 21) return bjEnd(W, u, R, true); touch(W, u); return { msg: 'Cards dealt.', casino: { g: 'bj', bj: n.bj, pv: bjVal(n.bj.p) } }; }
      const h = n.bj; if (!h) fail('Deal a new hand first.'); if (W.fairNonce != null && ['hit', 'double', 'stand'].includes(a)) h.nz = [...(h.nz || []), W.fairNonce];
      if (a === 'hit') { h.p.push(cardOf(R)); if (bjVal(h.p) > 21) return bjEnd(W, u, R); if (bjVal(h.p) === 21) return bjEnd(W, u, R); touch(W, u); return { msg: 'Hit.', casino: { g: 'bj', bj: h, pv: bjVal(h.p) } }; }
      if (a === 'double') { if (h.p.length !== 2) fail('You can only double down on your first two cards.'); if (n.cash < h.bet) fail('You do not have enough money to double.'); n.cash -= h.bet; h.bet *= 2; h.dbl = 1; h.p.push(cardOf(R)); return bjEnd(W, u, R); }
      if (a === 'stand') return bjEnd(W, u, R);
      fail('Unknown move.');
    }
    if (g === 'roulette') {
      const pick = String(c.pick); const num_ = /^\d+$/.test(pick) ? +pick : null; if (!(num_ != null ? num_ >= 0 && num_ <= 36 : ['red', 'black', 'odd', 'even', 'low', 'high'].includes(pick))) fail('Pick a number from 0 to 36 or an outside bet.');
      const bet = casinoBet(W, n, c.bet), x = Math.floor(R() * 37), col = x === 0 ? 'green' : CASINO.reds.includes(x) ? 'red' : 'black';
      const win = num_ != null ? x === num_ : x !== 0 && (pick === col || (pick === 'odd' && x % 2 === 1) || (pick === 'even' && x % 2 === 0) || (pick === 'low' && x <= 18) || (pick === 'high' && x >= 19));
      const pay = win ? bet * (num_ != null ? 36 : 2) : 0, net = casinoSettle(W, u, 'roulette', bet, pay, `${x} ${col}`);
      return { msg: win ? `${x} ${col}! You win ${moneyS(net)}.` : `${x} ${col}. You lose ${moneyS(bet)}.`, casino: { g: 'roulette', x, col, win, net, pick } };
    }
    if (g === 'slots') {
      const bet = casinoBet(W, n, c.bet), S_ = CASINO.slots, tot = S_.w.reduce((a, b) => a + b, 0), spin = () => { let r = R() * tot; for (let i = 0; i < S_.sym.length; i++) { r -= S_.w[i]; if (r < 0) return i; } return 0; };
      const reels = [spin(), spin(), spin()], sy = reels.map(i => S_.sym[i]); let mult = 0;
      if (reels[0] === reels[1] && reels[1] === reels[2]) mult = S_.three[reels[0]]; else { const cherries = sy.filter(x => x === 'cherry').length; if (cherries === 2) mult = S_.two.cherry; }
      const nm = reels.map(i => S_.name[i]), pay = Math.floor(bet * mult), net = casinoSettle(W, u, 'slots', bet, pay, nm.join(' · '));
      return { msg: mult >= 5 ? `Three ${nm[0].toLowerCase()}s. You win ${moneyS(net)} (${mult}×).` : mult ? `Two cherries. ${moneyS(pay)} back.` : `${nm.join(', ')}. No win.`, casino: { g: 'slots', reels: sy, mult, net } };
    }
    if (g === 'dice') {
      const pick = String(c.pick); if (!['low', 'seven', 'high'].includes(pick)) fail('Choose low, seven or high.'); const bet = casinoBet(W, n, c.bet), d1 = 1 + Math.floor(R() * 6), d2 = 1 + Math.floor(R() * 6), t = d1 + d2;
      const hit = (pick === 'low' && t < 7) || (pick === 'high' && t > 7) || (pick === 'seven' && t === 7), pay = hit ? Math.floor(bet * (pick === 'seven' ? CASINO.dice.seven : CASINO.dice.hl)) : 0, net = casinoSettle(W, u, 'dice', bet, pay, `${d1}+${d2}`);
      return { msg: hit ? `${d1} + ${d2} = ${t}. You win ${moneyS(net)}!` : `${d1} + ${d2} = ${t}. You lose ${moneyS(bet)}.`, casino: { g: 'dice', d: [d1, d2], t, win: hit, net, pick } };
    }
    fail('Unknown game.');
  }
  function bjEnd(W, u, R, natural) {
    const n = W.A[u], h = n.bj; delete n.bj; const pv = bjVal(h.p); h.d.push(cardOf(R)); // the dealer's hole card is only drawn now
    const dNat = h.d.length === 2 && bjVal(h.d) === 21; let res, pay = 0;
    if (pv > 21) res = 'bust';
    else if (natural || (h.p.length === 2 && pv === 21)) { if (dNat) { res = 'push'; pay = h.bet; } else { res = 'blackjack'; pay = Math.floor(h.bet * 2.5); } }
    else { while (bjVal(h.d) < 17) h.d.push(cardOf(R)); const dv = bjVal(h.d); if (dNat) res = 'lose'; else if (dv > 21 || pv > dv) { res = 'win'; pay = h.bet * 2; } else if (pv === dv) { res = 'push'; pay = h.bet; } else res = 'lose'; }
    n.cash += h.bet; // the stake was held aside during the hand; settle it as a normal bet
    const net = casinoSettle(W, u, 'bj', h.bet, pay, `${pv} vs ${bjVal(h.d)}`, h.nz), dv = bjVal(h.d);
    const msg = res === 'blackjack' ? `Blackjack! You win ${moneyS(net)}.` : res === 'win' ? `You win ${moneyS(net)} (${pv} vs ${dv > 21 ? 'dealer bust' : dv}).` : res === 'push' ? `Push: ${pv} each. Your bet is returned.` : res === 'bust' ? `Bust with ${pv}. You lose ${moneyS(h.bet)}.` : `Dealer has ${dv}. You lose ${moneyS(h.bet)}.`;
    return { msg, casino: { g: 'bj', bj: { ...h, done: 1 }, pv, dv, res, net } };
  }
  // ---------- passive simulation (every 10 real minutes) ----------
  function tickOnce(W, u, rng) {
    const n = W.A[u], hs = hexesOf(W, u), p = production(W, u), c = consumption(n), g = GOV[n.gov], w = wars(W, u).length, b = budget(n);
    for (const r in p) n.res[r] += p[r] - c[r];
    n.cash += hs.filter(h => ['P', 'D'].includes(P[h].t) && h != n.cap).length * 2000 * W.cfg.income;
    // government budget
    const spend = spendPerTick(n), domeK = domeUpkeep(W, n); n.cash -= spend + domeK; n.spent = (n.spent || 0) * .993 + spend + domeK; n.rev = (n.rev || 0) * .993;
    // part of the tax take arrives on its own (about enough to cover normal spending); the Collect Taxes operation brings in the rest
    const autoTax = taxIncome(W, u) * AUTO_TAX; n.cash += autoTax; n.rev += autoTax;
    const milFund = spend * b.mil / 100, need = upkeep(W, n), ratio = need > 0 ? milFund / need : 2;
    if (ratio >= 1) n.morale = clamp(n.morale + Math.min(2, (ratio - 1) * 4 + .5), 0, 100);
    else { n.morale = clamp(n.morale - 6 * (1 - ratio), 0, 100); if (n.morale < 30) { n.troops = Math.floor(n.troops * (1 - .02 * (1 - ratio))); } }
    const pctGdp = k => b.spend * b[k] / 100;
    const drift = (k, tgt, rate) => { n[k] = n[k] + (clamp(tgt, 0, 100) - n[k]) * rate; };
    drift('health', pctGdp('health') * 12 + fxAdd(n, 'health') + W.m.health, .03); drift('edu', pctGdp('edu') * 15 + fxAdd(n, 'edu'), .03); drift('iq', pctGdp('infra') * 14 + soft(n.infra, 10) * 2, .03);
    // interest and bankruptcy
    const interest = n.debt * interestRate(W, n) / 100 / TICKS_PER_YEAR; if (interest > 0) { if (n.cash >= interest) n.cash -= interest; else n.debt += interest; }
    if (n.debt > n.gdp * 2 || n.cash < -n.gdp * .2) {
      n.debt = Math.round(n.debt * .4); n.cash = Math.max(0, n.cash); n.stability = clamp(n.stability - 30, 0, 100); n.approval = clamp(n.approval - 20, 0, 100); n.gdp *= .85; n.infl = clamp(n.infl + 15, -2, 80); n.defaulted = W.now;
      news(W, u, `${n.name} has defaulted on its national debt. Its economy is in crisis.`); note(W, u, 'economy', 'Your government has gone bankrupt and defaulted on its debt. Lenders will not lend for 48 hours.');
    }
    const short = []; for (const r in n.res) if (n.res[r] < 0) { short.push(r); n.res[r] = 0; }
    const foodShort = short.includes('food'), goodsShort = short.includes('goods');
    // unemployment and inflation
    const deficit = (n.spent - n.rev) / Math.max(1, n.gdp) * TICKS_PER_YEAR / 144 * 100;
    const uT = 12 - soft(n.infra, 10) * .4 - n.edu * .04 - Math.min(5, traders(W, u).length) * .5 + w * 1.5 + (sanctioned(n) ? 4 : 0) + (n.infl > 10 ? 3 : 0) - (Math.min(b.spend, 30) - 15) * .15 + W.m.unemp + fxAdd(n, 'unemp');
    n.unemp = clamp(n.unemp + (clamp(uT, 1, 35) - n.unemp) * .05, 1, 40);
    const iT = 2 + Math.max(0, deficit) * .3 + debtRatio(n) * 3 + short.length * 2 - (n.tax - 20) * .05 + W.m.infl;
    n.infl = clamp(n.infl + (clamp(iT, -1, 60) - n.infl) * .04, -2, 80);
    // GDP
    n.gdp = n.gdp + (gdpTarget(W, u) - n.gdp) * .1;
    if (!n.gdpHist.length || W.now - n.gdpHist[n.gdpHist.length - 1].t >= HOUR) { n.gdpHist.push({ t: W.now, v: Math.round(n.gdp), p: Math.round(n.pop), m: Math.round(n.troops || 0) }); if (n.gdpHist.length > 48) n.gdpHist.shift(); }
    // population
    if (W.m.pandemic) n.pop *= 1 - .004 * W.m.pandemicCut * (1 - n.health / 100);
    if (foodShort) n.pop *= .985; else if (n.approval > 35) n.pop = Math.min(Math.max(n.pop, popCap(W, u)), n.pop * (1 + .012 * (.5 + n.health / 100)));
    if (n.cash < 0) n.morale = clamp(n.morale - 3, 0, 100);
    // public opinion
    const apT = 55 - (n.tax - 20) * 1.2 + g.ap - w * (n.gov === 'dem' ? 10 : n.gov === 'dic' ? 3 : 6) - (foodShort ? 15 : 0) - (goodsShort ? 8 : 0) - (sanctioned(n) ? 6 : 0) + Math.min(5, traders(W, u).length) * 1.5
      - Math.max(0, n.unemp - 6) * .8 - Math.max(0, n.infl - 4) * .5 + (n.health - 50) * .08 + (n.edu - 50) * .03 + W.m.apBonus + fxAdd(n, 'ap');
    n.approval = clamp(n.approval + (apT - n.approval) * .1, 0, 100);
    if (n.overC) delete n.overC; // (the old size upkeep is gone)
    const stT = 30 + n.approval * .5 + g.st + n.fort + fxAdd(n, 'st') - w * 5 - (n.aggr || 0) * .1 - Math.max(0, n.unemp - 10) * .5; n.stability = clamp(n.stability + (stT - n.stability) * .08, 0, 100);
    n.aggr = Math.max(0, (n.aggr || 0) - W.m.aggrDecay); if (n.hitBy) for (const k of Object.keys(n.hitBy)) if (W.now - n.hitBy[k] > 48 * HOUR) delete n.hitBy[k];
    if (nuked(W, n)) { n.pop *= .998; n.stability = clamp(n.stability - .2, 0, 100); }
    if (n.rad) { if (radOn(W, n)) { n.pop *= .9993; n.stability = clamp(n.stability - .05, 0, 100); n.approval = clamp(n.approval - .03, 0, 100); } else delete n.rad; }
    // (big empires no longer rebel for being big: size only costs money, via the size upkeep above)
    if (rogue(W, n)) { n.approval = clamp(n.approval - .1, 0, 100); n.stability = clamp(n.stability - .1, 0, 100); }
    if (n.stability < 25 && rng() < .05) { const lst = Object.keys(n.hexes).map(Number).filter(h => h != n.cap && owner(W, h) === u); if (lst.length) { const h = lst[Math.floor(rng() * lst.length)]; breakAway(W, u, h, 'fell to separatists, who declared independence'); } }
    if (n.gov !== 'dem' && n.stability < 12 && n.approval < 20 && rng() < .06) { const ks = Object.keys(GOV).filter(k => k !== n.gov); n.gov = ks[Math.floor(rng() * ks.length)]; n.cash *= .7; n.troops = Math.floor(n.troops * .85); n.stability = 45; n.approval = 50; if (n.gov === 'dem') n.nextElection = W.now + W.cfg.electionH * HOUR; news(W, u, `Revolution in ${n.name}. The new regime is a ${GOV[n.gov].n}.`); note(W, u, 'economy', `Revolution! Your nation is now a ${GOV[n.gov].n}.`); }
  }
  function election(W, u, rng) {
    const n = W.A[u];
    const vote = clamp(n.approval * .75 + 12 - n.unemp * .7 - Math.max(0, n.infl - 3) + (n.campaign || 0) + (n.rig || 0) + (rng() * 12 - 6), 3, 97);
    const v = Math.round(vote * 10) / 10; n.lastElection = { t: W.now, vote: v, won: vote >= 50 }; n.campaign = 0; n.rig = 0; n.nextElection = W.now + W.cfg.electionH * HOUR;
    if (vote >= 50) { n.stability = clamp(n.stability + 8, 0, 100); n.approval = clamp(n.approval + 4, 0, 100); gainXP(W, u, 40); news(W, u, `${n.name}'s government was re-elected with ${v}% of the vote.`); note(W, u, 'election', `You won re-election with ${v}% of the vote!`); }
    else {
      n.stability = clamp(n.stability - 15, 0, 100); n.approval = 55; n.tax = 20; n.budget = { ...DEFBUDGET }; n.cd.gov = W.now + 12 * HOUR;
      if (vote < 35) { n.cash *= .85; n.morale = clamp(n.morale - 15, 0, 100); news(W, u, `Landslide defeat in ${n.name}: the government won only ${v}% and a new administration has taken over.`); note(W, u, 'election', `Landslide defeat (${v}%). A new administration has reversed your policies and purged ministries.`); }
      else { news(W, u, `The government of ${n.name} lost its election with ${v}% of the vote. A coalition takes power.`); note(W, u, 'election', `You lost the election with ${v}%. The new coalition reset your tax rate and budget.`); }
    }
  }
  // Runs on the server about twice a minute for every nation.
  // conquered provinces stay restless for 48 hours: without ~800 troops per province, they may rise up
  const GARRISON = 800;
  function rebels(W, u, rng) {
    const n = W.A[u]; let any = false; const held = hexesOf(W, u).length, ratio = (n.troops || 0) / Math.max(1, held * GARRISON);
    for (const [h, c] of Object.entries(n.conq || {})) {
      if (W.now - c.t > 48 * HOUR || owner(W, h) !== u) { delete n.conq[h]; any = true; continue; }
      const p = .02 * (1 - Math.min(1, ratio)) * (n.stability < 40 ? 1.5 : 1);
      if (p > 0 && rng() < p) {
        const back = c.from && W.A[c.from] ? c.from : null; if (!back) { breakAway(W, u, h, 'rose up against its new rulers'); delete n.conq[h]; any = true; continue; } delete n.hexes[h]; delete n.conq[h]; any = true;
        if (back) { xferDev(W, u, back, h, 1); W.A[back].hexes[h] = W.now; log(W.A[back], `${pname(h)} rose up against ${n.name} and rejoined your nation.`, W); note(W, back, 'attack', `${pname(h)} rebelled against ${n.name} and returned to you!`); touch(W, back); }
        W.OWN = computeOwn(W.A); n.stability = clamp(n.stability - 3, 0, 100);
        log(n, `Rebellion! ${pname(h)} rose up and ${back ? 'returned to ' + W.A[back].name : 'declared independence'}. Keep about ${GARRISON} troops per province to hold new land.`, W);
        note(W, u, 'attack', `Rebellion in ${pname(h)} — the province ${back ? 'returned to ' + W.A[back].name : 'broke away'}.`);
        news(W, u, `${pname(h)} rebelled against ${n.name}${back ? ' and rejoined ' + W.A[back].name : ''}.`);
      }
    }
    return any;
  }
  function rogueCheck(W, u) {
    const n = W.A[u]; if (!n) return false;
    if ((n.aggr || 0) >= ROGUE_AT) {
      const was = rogue(W, n); if (!was) n.rogueT = W.now; n.rogue = Math.max(n.rogue || 0, W.now + ROGUE_MIN);
      if (!was) {
        news(W, u, `☠ ${n.name} has been declared a rogue state. The world has imposed a full embargo.`);
        log(n, 'Your nation has been declared a rogue state: full trade embargo, trade agreements cancelled, allies have walked away, and the world may attack you freely. It lasts at least 12 hours and ends only when your aggression falls below 50.', W);
        note(W, u, 'war', '☠ Your nation is now a rogue state under full international embargo.');
        for (const a of allies(W, u)) { setRel(W.A[a], u, 'unally', W.now); note(W, a, 'diplo', `You ended your alliance with ${n.name}, which has been declared a rogue state.`); touch(W, a); }
        for (const v of others(W, u)) if (!W.A[v].ai) note(W, v, 'war', `☠ ${n.name} has been declared a rogue state. Attacking it adds no aggression, and you fight it at +15% strength.`);
      }
      return !was;
    }
    // rogue states from before this change (24 hours) also end after 12 hours once aggression is below 50
    if (n.rogue && W.now < n.rogue && (n.aggr || 0) < 50 && W.now >= (n.rogueT || n.rogue - 24 * HOUR) + ROGUE_MIN) n.rogue = W.now;
    if (n.rogue && W.now >= n.rogue) {
      if ((n.aggr || 0) < 50) { n.rogue = 0; news(W, u, `International sanctions on ${n.name} have been lifted.`); note(W, u, 'war', 'The world has lifted its embargo. Your nation is no longer a rogue state.'); }
      else n.rogue = W.now + 3 * HOUR; // still too aggressive: the embargo continues
      return true;
    }
    return false;
  }
  function tick(W, u, active, rng) {
    const n = W.A[u]; let changed = false;
    const k = Math.floor((W.now - n.lastTick) / TICK);
    if (k > 0) { if (active) for (let i = 0; i < Math.min(k, 12); i++) tickOnce(W, u, rng); else if ((n.aggr || 0) > 0) n.aggr = Math.max(0, n.aggr - k * W.m.aggrDecay); /* aggression keeps cooling while the leader is offline */ n.lastTick += k * TICK; changed = true; }
    if (W.now - n.nextCard > 3 * HOUR) n.nextCard = W.now - 3 * HOUR;
    if (rogueCheck(W, u)) changed = true;
    if (n.nuke) { if (!n.iaeaAt) { n.iaeaAt = W.now + INSPECT.everyH * HOUR; changed = true; } else if (W.now >= n.iaeaAt) { const fee = inspectFee(n), pay = Math.max(0, Math.min(fee, n.cash)); n.cash -= pay; if (fee > pay) n.debt = (n.debt || 0) + (fee - pay); n.iaeaAt = W.now + INSPECT.everyH * HOUR; n.iaeaPaid = fee;
      log(n, `Mandatory international nuclear inspections: ${money(fee)} charged${fee > pay ? ` (${money(fee - pay)} added to your debt)` : ''}. Every nuclear nation pays this once a day.`, W); note(W, u, 'economy', `☢ Daily nuclear inspection fee: ${money(fee)}.`); changed = true; } }
    if (expedResolve(W, u, rng)) changed = true;
    if (autoBuyTick(W, u)) changed = true;
    if (n.dome && n.dome.up && n.dome.up.ready <= W.now) { n.dome.lvl = n.dome.up.lvl; delete n.dome.up; note(W, u, 'economy', `🛡 Your Golden Dome is now level ${n.dome.lvl}: it stops ${Math.round(domeMis(n) * 100)}% of missiles and has a ${Math.round(domeNuke(n) * 100)}% chance against a nuclear missile.`); changed = true; }
    if (offersExpire(W, u)) changed = true;
    if (n.frozen && n.frozen.until <= W.now) { const a = n.frozen.amt || 0; n.cash += a; n.frozen = null; log(n, `The asset freeze has ended: ${money(a)} returned to your treasury.`, W); note(W, u, 'council', `The World Council asset freeze has ended. ${money(a)} is back in your treasury.`); changed = true; }
    if (k > 0) { mState(W, u); achCheck(W, u); }
    if (n.chain && W.now >= n.chain.at && n.cards.length < 4) { n.cards.push({ id: rid(), i: 'ch:' + n.chain.k }); delete n.chain; changed = true; }
    if (k > 0 && n.conq) for (let i = 0; i < Math.min(k, 12); i++) if (rebels(W, u, rng)) changed = true;
    if (k > 0 && active) for (let i = 0; i < Math.min(k, 12); i++) if (neglect(W, u, rng)) changed = true;
    if (k > 0) for (let i = 0; i < Math.min(k, 12); i++) { if (overTick(W, u, rng)) changed = true; if (farLands(W, u, rng)) changed = true; if (tributeTick(W, u)) changed = true; if (active && rushTick(W, u, rng)) changed = true; } if (outpostTidy(W, u)) changed = true; if (k > 0 && comebackTick(W, u)) changed = true;
    if (!n.ai && n.stability < REBEL.st && hexesOf(W, u).length >= REBEL.minProv && W.now - (n.rebWarn || 0) > 12 * HOUR) { n.rebWarn = W.now; note(W, u, 'attack', `⚠ Unrest is spreading: with stability below ${REBEL.st}, outlying provinces may declare independence. Raise stability (Address the Nation, budget, laws) and keep troops in your provinces.`); changed = true; }
    while (W.now >= n.nextCard) { if (n.cards.length < 3 && active) addCard(W, u, rng); n.nextCard += 40 * MIN; changed = true; }
    if (n.gov === 'dem' && n.nextElection && W.now >= n.nextElection) { election(W, u, rng); changed = true; }
    for (const h of Object.keys(n.hexes)) if (owner(W, h) !== u) { delete n.hexes[h]; changed = true; }
    if (changed) touch(W, u);
    return changed;
  }
  // a world event begins: every nation gets a response decision
  function startEvent(W, key) { const e = EVENTS[key]; if (!e) return; for (const u of Object.keys(W.A)) { const n = W.A[u]; n.cards = [{ id: rid(), i: 'ev:' + key }, ...n.cards.filter(c => c.i !== 'ev:' + key)].slice(0, 4); touch(W, u); } }


  // ================= national laws =================
  const lawSlots = n => Math.min(5, 1 + Math.floor(rankOf(n.xp) / 2));
  const lawCost = n => Math.max(1e5, Math.round((n.gdp || 0) * .005));
  function setLaw(W, u, k, on) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(LAWS, k)) fail('Unknown law.'); n.laws = n.laws || [];
    if (left(W, n, 'law')) fail(`Parliament needs time before another change: ${fmtT(left(W, n, 'law'))}.`);
    if (on) {
      if (n.laws.includes(k)) fail('That law is already in force.');
      if (n.laws.length >= lawSlots(n)) fail(`Your rank allows ${lawSlots(n)} law${lawSlots(n) > 1 ? 's' : ''} at once. Repeal one first, or rank up.`);
      const c = lawCost(n); if (n.cash < c) fail(`Passing a law costs ${money(c)}.`);
      n.cash -= c; n.laws.push(k); log(n, `Passed a new law: ${LAWS[k].n}.`, W); news(W, u, `${n.name} has passed a new law: ${LAWS[k].n}.`);
    } else { if (!n.laws.includes(k)) fail('That law is not in force.'); n.laws = n.laws.filter(x => x !== k); log(n, `Repealed: ${LAWS[k].n}.`, W); }
    n.cd.law = W.now + 6 * HOUR; touch(W, u); achCheck(W, u);
    return { msg: on ? `${LAWS[k].n} is now law.` : `${LAWS[k].n} repealed.` };
  }

  // ================= megaprojects =================
  const wonderHolder = (W, k) => Object.keys(W.A).find(v => W.A[v].wonders && W.A[v].wonders[k]) || null;
  const STAGE_H = 8;
  function wonder(W, u, k, abandon) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(WONDERS, k)) fail('Unknown project.'); const Wd = WONDERS[k];
    if (abandon) { if (!n.proj || n.proj.k !== k) fail('You are not building that.'); n.proj = null; log(n, `Abandoned the ${Wd.n}.`, W); touch(W, u); return { msg: `${Wd.n} abandoned.` }; }
    if (rankOf(n.xp) < 2) fail('Megaprojects need the rank of Mayor.');
    const h = wonderHolder(W, k); if (h) fail(h === u ? 'You already own this wonder.' : `${W.A[h].name} already owns the ${Wd.n}.`);
    if (n.proj && n.proj.k !== k) fail(`You are already building the ${WONDERS[n.proj.k].n}. One megaproject at a time.`);
    if (n.proj && n.proj.next > W.now) fail(`Workers are still building stage ${n.proj.stage}: next stage in ${fmtT(n.proj.next - W.now)}.`);
    const c = Wd.cost; for (const r in c) if ((r === 'cash' ? n.cash : n.res[r] || 0) < c[r]) fail(`Each stage needs ${money(c.cash)}${Object.keys(c).filter(r => r !== 'cash').map(r => `, ${num(c[r])} ${r}`).join('')}.`);
    for (const r in c) { if (r === 'cash') n.cash -= c[r]; else n.res[r] -= c[r]; }
    const first = !n.proj; n.proj = n.proj || { k, stage: 0, spent: 0, t: W.now }; n.proj.stage++; n.proj.spent += c.cash; n.proj.next = W.now + STAGE_H * HOUR;
    if (first) { news(W, u, `${n.name} has begun building the ${Wd.n}.`); for (const v of Object.keys(W.A)) if (v !== u && W.A[v].proj && W.A[v].proj.k === k) note(W, v, 'economy', `${n.name} is racing you to build the ${Wd.n}!`); }
    if (n.proj.stage >= Wd.stages) {
      n.wonders = { ...(n.wonders || {}), [k]: W.now }; n.proj = null; gainXP(W, u, 150);
      news(W, u, `🏛 ${n.name} has completed the ${Wd.n} — a wonder of the world!`); log(n, `The ${Wd.n} is complete: ${Wd.d}`, W);
      for (const v of Object.keys(W.A)) { const o = W.A[v]; if (v !== u && o.proj && o.proj.k === k) { const back = Math.round(o.proj.spent * .5); o.cash += back; o.proj = null; note(W, v, 'economy', `${n.name} finished the ${Wd.n} first. Half of what you spent (${money(back)}) was refunded.`); log(o, `Lost the race for the ${Wd.n}; ${money(back)} refunded.`, W); touch(W, v); } }
      for (const v of Object.keys(W.A)) if (v !== u && !W.A[v].ai) note(W, v, 'event', `🏛 ${n.name} completed the ${Wd.n}.`);
      achCheck(W, u); touch(W, u); return { msg: `🏛 The ${Wd.n} is complete!` };
    }
    log(n, `${Wd.n}: stage ${n.proj.stage} of ${Wd.stages} complete.`, W); gainXP(W, u, 20); touch(W, u);
    return { msg: `${Wd.n}: stage ${n.proj.stage} of ${Wd.stages} done. Next stage in ${STAGE_H} hours.` };
  }

  // ================= expeditions =================
  function expedition(W, u, k) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!has(EXPEDS, k)) fail('Unknown destination.'); const E = EXPEDS[k];
    if (rankOf(n.xp) < 1) fail('Expeditions need the rank of Elder.'); if (n.exped) fail(`Your expedition returns in ${fmtT(n.exped.end - W.now)}.`);
    if (E.coast && !hasCoast(W, u)) fail('A deep-sea expedition needs a coastal province.');
    const c = E.cost; for (const r in c) if ((r === 'cash' ? n.cash : n.res[r] || 0) < c[r]) fail(`This expedition needs ${money(c.cash)}${Object.keys(c).filter(r => r !== 'cash').map(r => `, ${num(c[r])} ${r}`).join('')}.`);
    for (const r in c) { if (r === 'cash') n.cash -= c[r]; else n.res[r] -= c[r]; }
    n.exped = { k, t: W.now, end: W.now + E.h * HOUR }; log(n, `An expedition has set out: ${E.n}. It returns in ${E.h} hours.`, W); touch(W, u); mTrack(W, u, 'exped', 1);
    return { msg: `Expedition launched — back in ${E.h} hours.` };
  }
  function expedResolve(W, u, rng) {
    const n = W.A[u], x = n.exped; if (!x || W.now < x.end) return false; n.exped = null; const E = EXPEDS[x.k]; if (!E) return true;
    const scale = 1 + rankOf(n.xp) * .4, roll = rng(); let txt;
    const resAmt = Math.round((300 + rng() * 500) * scale);
    if (roll < .08) { n.troops = Math.max(0, n.troops - Math.round(30 + rng() * 60)); n.approval = clamp(n.approval - 3, 0, 100); txt = `Disaster: the ${E.n.toLowerCase()} was lost. The nation mourns.`; }
    else if (roll < .22) txt = `The ${E.n.toLowerCase()} returned empty-handed.`;
    else if (E.res === 'tech' && roll > .82) { n.tech = (n.tech || 0) + 1; txt = `Breakthrough! The ${E.n.toLowerCase()} advanced your nation to tech level ${n.tech}.`; }
    else if (roll > .9) { n.approval = clamp(n.approval + 5, 0, 100); n.stability = clamp(n.stability + 3, 0, 100); gainXP(W, u, 40); txt = `Discovery! The ${E.n.toLowerCase()} uncovered a priceless artifact — national pride soars (+5 approval, +3 stability, +40 XP).`; }
    else if (E.res === 'cash') { const v = Math.round(Math.max(3e5, (n.gdp || 0) * .02) * (.6 + rng())); n.cash += v; txt = `Treasure! The ${E.n.toLowerCase()} recovered ${money(v)}.`; }
    else if (E.res === 'tech') { const v = Math.round(resAmt * .6); n.res.goods += v; txt = `The ${E.n.toLowerCase()} brought back research samples worth ${num(v)} goods.`; }
    else { const big = roll > .75, v = big ? resAmt * 2 : resAmt; n.res[E.res] += v; txt = `${big ? 'Rich find!' : 'Success.'} The ${E.n.toLowerCase()} brought back ${num(v)} ${E.res}.`; }
    n.tally = n.tally || {}; n.tally.exped = (n.tally.exped || 0) + 1; gainXP(W, u, 15);
    log(n, txt, W); note(W, u, 'economy', txt); achCheck(W, u); return true;
  }

  // ================= daily missions =================
  const dayKey = t => new Date(t).toISOString().slice(0, 10);
  const mReward = n => Math.round(Math.max(2e5, (n.gdp || 0) * .006));
  function missionsFor(W, u) {
    const n = W.A[u], day = dayKey(W.now); if (n.mis && n.mis.day === day) return n.mis;
    let h = 0; for (const ch of u + day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const atWar_ = wars(W, u).length > 0, pool = Object.keys(MISSIONS).filter(k => (!MISSIONS[k].war || atWar_) && !(k === 'exped' && rankOf(n.xp) < 1));
    const pick = []; while (pick.length < 3 && pool.length) { h = (h * 1103515245 + 12345) >>> 0; pick.push(pool.splice(h % pool.length, 1)[0]); }
    n.mis = { day, list: pick.map(k => ({ k, p: 0, done: false, claimed: false })), bonus: false }; return n.mis;
  }
  function mTrack(W, u, k, amt) {
    const n = W.A[u]; if (!n) return; const m = missionsFor(W, u); let ch = false;
    for (const x of m.list) if (!x.done && x.k === k) { x.p = Math.min(MISSIONS[k].goal, x.p + amt); if (x.p >= MISSIONS[k].goal) { x.done = true; note(W, u, 'ready', `Daily mission complete: ${MISSIONS[k].n}. Claim your reward on the Projects page.`); } ch = true; }
    if (ch) touch(W, u);
  }
  function mState(W, u) { const n = W.A[u]; if (n.approval >= 70) mTrack(W, u, 'approval', 1); if (n.stability >= 65) mTrack(W, u, 'stability', 1); }
  function claimMission(W, u, i) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const m = missionsFor(W, u), x = m.list[Number(i)]; if (!x) fail('Unknown mission.');
    if (!x.done) fail('That mission is not finished yet.'); if (x.claimed) fail('Already claimed.');
    const r = mReward(n); x.claimed = true; n.cash += r; gainXP(W, u, 30); n.tally = n.tally || {}; n.tally.missions = (n.tally.missions || 0) + 1; let msg = `Mission reward: ${money(r)} and 30 XP.`;
    if (m.list.every(y => y.claimed) && !m.bonus) { m.bonus = true; n.cash += r; gainXP(W, u, 50); msg += ` All three done — bonus ${money(r)} and 50 XP!`; }
    log(n, msg, W); achCheck(W, u); touch(W, u); return { msg };
  }

  // ================= achievements =================
  function achCheck(W, u) {
    const n = W.A[u]; if (!n) return; n.ach = n.ach || {}; const t = n.tally || {}, got = [];
    const test = { prov10: () => hexesOf(W, u).length >= 10, prov25: () => hexesOf(W, u).length >= 25, tech10: () => n.tech >= 10, tech20: () => n.tech >= 20, gdp1b: () => n.gdp >= 1e9, gdp10b: () => n.gdp >= 1e10,
      rich: () => n.cash >= 1e8, streak7: () => n.streak && n.streak.c >= 7, diplomat: () => allies(W, u).length >= 3, trader: () => (n.cnt.trades || 0) >= 50, wonder: () => Object.keys(n.wonders || {}).length > 0,
      nuclear: () => !!n.nuke, survivor: () => W.now - n.created >= 30 * 864e5, general: () => (n.gens || []).some(g => g.stars >= 5), senator: () => rankOf(n.xp) >= 4, president: () => rankOf(n.xp) >= 6,
      explorer: () => (t.exped || 0) >= 5, lawmaker: () => (n.laws || []).length >= 3, missions: () => (t.missions || 0) >= 30, dealmaker: () => (t.deals || 0) >= 5, firstWin: () => (t.wins || 0) >= 1, conqueror: () => (t.caps || 0) >= 1 };
    for (const k in test) if (!n.ach[k] && test[k]()) { achGrant(W, u, k); got.push(ACH[k][0]); }
    if (got.length) touch(W, u);
  }

  // ================= direct trade offers between nations =================
  const OFFER_KEYS = ['cash', 'food', 'oil', 'steel', 'goods'];
  // provinces can be part of a deal too (up to 3 a side). They are not held in escrow: ownership is checked again when the deal is accepted.
  const PROV_MAX = 3, PROV_LOCK = 24 * HOUR;
  const cleanBundle = b => { const o = {}; for (const k of OFFER_KEYS) { const v = Math.floor(Number((b || {})[k]) || 0); if (v < 0) fail('Amounts cannot be negative.'); if (v > 1e12) fail('That amount is too large.'); if (v) o[k] = v; }
    const pv = (b || {}).prov; if (pv != null) { if (!Array.isArray(pv)) fail('Choose provinces from the list.'); const l = [...new Set(pv.map(x => Math.floor(Number(x))))]; if (l.some(h => !(h >= 0) || !P[h])) fail('Unknown province.'); if (l.length > PROV_MAX) fail(`At most ${PROV_MAX} provinces per side.`); if (l.length) o.prov = l; } return o; };
  const bundleTxt = b => Object.keys(b).length ? Object.entries(b).map(([k, v]) => k === 'prov' ? v.map(h => pname(h)).join(' + ') : k === 'cash' ? money(v) : `${num(v)} ${k}`).join(' + ') : 'nothing';
  const hasBundle = (n, b) => Object.entries(b).every(([k, v]) => k === 'prov' || (k === 'cash' ? n.cash : n.res[k] || 0) >= v);
  // can nation u hand these provinces to nation v right now?
  function provCheck(W, u, v, list, out) {
    if (!list || !list.length) return null; const a = W.A[u], b = W.A[v];
    for (const h of list) { if (owner(W, h) !== u) return `${a.name} no longer owns ${pname(h)}.`; if (h == a.cap) return 'A capital can never be traded.'; if (a.ptrade && W.now - (a.ptrade[h] || 0) < PROV_LOCK) return `${pname(h)} changed hands less than 24 hours ago and can't be traded again yet.`; }
    if (hexesOf(W, u).length - list.length < 1) return `${a.name} can't give away all of its land.`;
    { const a = adminState(W, v); if (isFinite(a.cap) && a.used + list.length * ADMIN.colony > a.cap + (out || 0)) return `${b.name} doesn't have enough administration for that land (${a.used} of ${a.cap} used).`; }

    return null;
  }
  function moveProv(W, u, v, list) { const a = W.A[u], b = W.A[v]; for (const h of list || []) { xferDev(W, u, v, h, 0); delete a.hexes[h]; if (a.conq) delete a.conq[h]; b.hexes[h] = W.now; b.ptrade = b.ptrade || {}; b.ptrade[h] = W.now; }
    for (const x of [a, b]) if (x.ptrade) for (const k of Object.keys(x.ptrade)) if (W.now - x.ptrade[k] > PROV_LOCK) delete x.ptrade[k];
    if (list && list.length) { a.approval = clamp(a.approval - 3, 0, 100); W.OWN = computeOwn(W.A); } }
  const moveBundle = (from, to, b) => { for (const [k, v] of Object.entries(b)) { if (k === 'prov') continue; if (k === 'cash') { if (from) from.cash -= v; if (to) to.cash += v; } else { if (from) from.res[k] -= v; if (to) to.res[k] += v; } } };
  function canDeal(W, u, v) { const a = W.A[u], b = W.A[v]; if (atWar(W, u, v)) return 'You are at war.'; if (rogue(W, a) || rogue(W, b)) return 'Rogue states cannot trade.'; if (embargoed(W, a) || embargoed(W, b)) return 'A World Council embargo is in force.'; return null; }
  function offer(W, u, v, give, want) {
    const me = W.A[u], them = has(W.A, v) ? W.A[v] : null; if (!me) fail('Found a nation first.'); if (!them || v === u) fail('Choose another nation.');
    const why = canDeal(W, u, v); if (why) fail(why);
    give = cleanBundle(give); want = cleanBundle(want); if (!Object.keys(give).length || !Object.keys(want).length) fail('Offer something and ask for something in return. (To give for free, use aid.)');
    if ((give.prov || want.prov) && them.ai) fail('AI nations do not trade land. Provinces can only be traded with other players.');
    { const w1 = provCheck(W, u, v, give.prov, (want.prov || []).length) || provCheck(W, v, u, want.prov, (give.prov || []).length); if (w1) fail(w1); }
    me.offOut = me.offOut || []; them.offIn = them.offIn || []; if (me.offOut.length >= 5) fail('You can have at most 5 offers waiting.'); if (them.offIn.length >= 10) fail(`${them.name} has too many offers waiting.`);
    if (!hasBundle(me, give)) fail(`You do not have ${bundleTxt(give)}.`);
    moveBundle(me, null, give); // held in escrow until accepted, declined, cancelled or expired
    const id = rid(), o = { id, give, want, t: W.now, exp: W.now + 24 * HOUR };
    me.offOut.push({ ...o, to: v }); them.offIn.push({ ...o, from: u });
    note(W, v, 'diplo', `${me.name} offers ${bundleTxt(give)} for ${bundleTxt(want)}. Answer on the Diplomacy page.`); log(me, `Offered ${bundleTxt(give)} to ${them.name} for ${bundleTxt(want)}.`, W); touch(W, u, v);
    const held = { ...give }; delete held.prov;
    return { msg: `Offer sent to ${them.name}.${Object.keys(held).length ? ` Your ${bundleTxt(held)} is held until they answer (24 hours).` : ' They have 24 hours to answer.'}${give.prov ? ' Your provinces stay yours until they accept.' : ''}` };
  }
  const dropOffer = (W, id, fromU, toU, refund) => { const a = W.A[fromU], b = W.A[toU]; const o = a && (a.offOut || []).find(x => x.id === id); if (a) a.offOut = (a.offOut || []).filter(x => x.id !== id); if (b) b.offIn = (b.offIn || []).filter(x => x.id !== id); if (o && refund && a) moveBundle(null, a, o.give); return o; };
  function answerOffer(W, u, id, accept) {
    const me = W.A[u]; if (!me) fail('Found a nation first.'); const o = (me.offIn || []).find(x => x.id === id); if (!o) fail('That offer is no longer available.');
    const from = W.A[o.from]; if (!from) { me.offIn = me.offIn.filter(x => x.id !== id); touch(W, u); fail('That nation no longer exists.'); }
    if (!accept) { dropOffer(W, id, o.from, u, true); note(W, o.from, 'diplo', `${me.name} declined your offer of ${bundleTxt(o.give)} for ${bundleTxt(o.want)}.`); touch(W, u, o.from); return { msg: 'Offer declined.' }; }
    const why = canDeal(W, u, o.from); if (why) fail(why); if (!hasBundle(me, o.want)) fail(`You need ${bundleTxt(o.want)} to accept.`);
    { const w1 = provCheck(W, o.from, u, o.give.prov, (o.want.prov || []).length) || provCheck(W, u, o.from, o.want.prov, (o.give.prov || []).length); if (w1) fail(w1); }
    dropOffer(W, id, o.from, u, false); moveBundle(me, from, o.want); moveBundle(null, me, o.give); moveProv(W, o.from, u, o.give.prov); moveProv(W, u, o.from, o.want.prov);
    for (const x of [me, from]) { x.tally = x.tally || {}; x.tally.deals = (x.tally.deals || 0) + 1; }
    log(me, `Trade with ${from.name}: received ${bundleTxt(o.give)}, paid ${bundleTxt(o.want)}.`, W); log(from, `${me.name} accepted your offer: received ${bundleTxt(o.want)} for ${bundleTxt(o.give)}.`, W);
    note(W, o.from, 'diplo', `${me.name} accepted your trade: you received ${bundleTxt(o.want)}.`); news(W, u, o.give.prov || o.want.prov ? `🗺 Land changed hands: ${from.name} traded ${bundleTxt(o.give)} to ${me.name} for ${bundleTxt(o.want)}.` : `${me.name} and ${from.name} struck a trade deal.`);
    achCheck(W, u); achCheck(W, o.from); touch(W, u, o.from); return { msg: `Deal done: you received ${bundleTxt(o.give)}.` };
  }
  const RELEASE = { st: 6, ap: 5, cdMin: 60 };
  function releaseProv(W, u, h) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); h = Math.floor(Number(h)); if (!P[h] || owner(W, h) !== u) fail('That province is not yours.');
    if (h == n.cap) fail('You cannot release your capital.'); if (hexesOf(W, u).length <= 1) fail('You cannot release your last province.');
    delete n.hexes[h]; if (n.conq) delete n.conq[h]; if (n.dev) delete n.dev[h]; W.OWN = computeOwn(W.A); // no waiting between releases
    if (n.lh) n.lh = n.lh.map(x => [x[0], Math.max(0, x[1] - 1)]); // a released province never counts as land lost
    log(n, `You released ${pname(h)}. It is now free land anyone can settle.`, W); // no stability or approval penalty
    news(W, u, `🗺 ${n.name} gave up ${pname(h)}. The province is now free land.`); touch(W, u);
    return { msg: `${pname(h)} released. It is now free land.` };
  }
  function cancelOffer(W, u, id) { const me = W.A[u]; if (!me) fail('Found a nation first.'); const o = (me.offOut || []).find(x => x.id === id); if (!o) fail('That offer is no longer open.'); dropOffer(W, id, u, o.to, true); touch(W, u, o.to); return { msg: 'Offer withdrawn; your goods are back.' }; }
  function offersExpire(W, u) { const n = W.A[u]; let ch = false; for (const o of [...(n.offOut || [])]) if (W.now > o.exp || !W.A[o.to]) { dropOffer(W, o.id, u, o.to, true); note(W, u, 'diplo', `Your offer to ${W.A[o.to] ? W.A[o.to].name : 'a nation'} expired; your goods were returned.`); ch = true; }
    for (const o of [...(n.offIn || [])]) if (W.now > o.exp + 60e3 || !W.A[o.from]) { n.offIn = n.offIn.filter(x => x.id !== o.id); ch = true; } return ch; }

  // ================= flag and motto =================
  function setFlag(W, u, f, motto) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); f = f || {};
    const l = FLAG_LAYOUTS.includes(f.l) ? f.l : 'solid', e = FLAG_EMBLEMS.includes(f.e) ? f.e : 'none', c = (Array.isArray(f.c) ? f.c : []).slice(0, 4).map(x => FLAG_HEX.test(x) ? String(x).toLowerCase() : FLAG_COLORS[0]);
    while (c.length < 3) c.push(FLAG_COLORS[10]);
    const fl = { l, c, e }, int = (v, a, b) => { v = Math.round(+v); return v >= a && v <= b ? v : 0; };
    if (['stripes', 'vstripes', 'starsstripes'].includes(l) && int(f.sn, 3, 15)) fl.sn = int(f.sn, 3, 15);
    if (e !== 'none') { if (['c', 'k', 'h'].includes(f.ep)) fl.ep = f.ep; if (int(f.es, 1, 3)) fl.es = int(f.es, 1, 3); if (FLAG_HEX.test(f.ec)) fl.ec = String(f.ec).toLowerCase(); if (['stars', 'starring'].includes(e) && int(f.en, 1, 15)) fl.en = int(f.en, 1, 15); }
    if (f.fr && isChampion(n)) fl.fr = 1; // the champion's gold frame
    n.flag = fl; if (motto != null) { const m = String(motto).replace(/\s+/g, ' ').trim().slice(0, 60); n.motto = m; }
    touch(W, u); return { msg: 'Flag and motto saved.' };
  }
  // map colour: change once a day
  function setColor(W, u, col) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (CHAMP_COLORS.includes(col)) { if (!isChampion(n)) fail('Only past season champions can use this colour.'); } else if (!COLORS.includes(col)) fail('Pick a colour from the list.');
    if (col === n.color) fail('That is already your map colour.'); n.cd = n.cd || {}; const now = W.now || Date.now();
    if (n.cd.color && now < n.cd.color) fail('You can change your map colour again in ' + Math.ceil((n.cd.color - now) / 36e5) + 'h.');
    n.color = col; n.cd.color = now + 864e5; touch(W, u); return { msg: 'Map colour changed.' };
  }


  // ---------- alliances (teams) ----------
  const blocCap = b => (b.done && b.done.hq) ? BLOC.hqMax : BLOC.max;
  const blocGdp = (W, b) => (b.members || []).reduce((s, m) => s + ((W.A[m] && W.A[m].gdp) || 0), 0);
  // each project stage costs 2% of the members' combined GDP (at least $25M), paid from the alliance treasury
  const blocStageCost = (W, b) => Math.round(Math.max(25e6, blocGdp(W, b) * .02) / 1e5) * 1e5;
  const blocGoalReward = (W, b) => Math.round(Math.max(5e6, blocGdp(W, b) * .005) / 1e5) * 1e5;
  const blocScore = (W, b) => (b.members || []).filter(m => W.A[m]).reduce((s, m) => s + score(W, m), 0) + Object.keys(b.done || {}).length * 500;
  const today = t => new Date(t).toISOString().slice(0, 10);
  function blocGoalState(W, b) { const d = today(W.now); if (!b.goal || b.goal.day !== d) b.goal = { day: d, ops: 0, dec: 0, done: {} }; const m = Math.max(1, (b.members || []).length); return { ...b.goal, need: { ops: BLOC.goalOps * m, dec: BLOC.goalDec * m } }; }
  function blocGoal(W, u, k) {
    const b = blocOf(W, u); if (!b) return; const g0 = blocGoalState(W, b), g = b.goal; g[k] = (g[k] || 0) + 1; W.bch = true;
    if (!g.done[k] && g[k] >= g0.need[k]) {
      g.done[k] = W.now; const rw = blocGoalReward(W, b); b.bank = (b.bank || 0) + rw;
      for (const m of b.members) if (W.A[m]) { gainXP(W, m, 40); note(W, m, 'diplo', `🤝 Alliance goal reached: ${k === 'ops' ? 'operations' : 'decisions'}! ${money(rw)} went into the ${b.name} treasury and every member earned 40 XP.`); touch(W, m); }
      blocLog(b, `Team goal reached (${k === 'ops' ? 'operations' : 'decisions'}): ${money(rw)} added to the treasury.`, W);
    }
  }
  const blocLog = (b, x, W) => { b.log = [{ t: W.now, x }, ...(b.log || [])].slice(0, 30); };
  const cleanName = (v, min, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  function blocFlag(f) { f = f || {}; const l = FLAG_LAYOUTS.includes(f.l) ? f.l : 'h3', e = FLAG_EMBLEMS.includes(f.e) ? f.e : 'star', c = (Array.isArray(f.c) ? f.c : []).slice(0, 3).map(x => FLAG_HEX.test(x) ? String(x).toLowerCase() : FLAG_COLORS[6]); while (c.length < 3) c.push(FLAG_COLORS[10]); return { l, c, e }; }
  function blocCmd(W, u, op, c) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const mine = blocOf(W, u);
    const isLeader = mine && mine.leader === u, needLeader = () => { if (!mine) fail('You are not in an alliance.'); if (!isLeader) fail('Only the alliance leader can do that.'); };
    const nameOk = (name, skip) => { const x = cleanName(name, BLOC.nameMin, BLOC.nameMax); if (x.length < BLOC.nameMin) fail(`Alliance names need at least ${BLOC.nameMin} characters.`); if (Object.values(W.B).some(b => b !== skip && b.name.toLowerCase() === x.toLowerCase())) fail('Another alliance already uses that name.'); return x; };
    const tagOk = (tag, skip) => { const x = String(tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); if (x.length < 2) fail('The tag needs 2 to 4 letters or numbers.'); if (Object.values(W.B).some(b => b !== skip && b.tag === x)) fail('Another alliance already uses that tag.'); return x; };
    const peer = v => { if (!has(W.A, v)) fail('Unknown nation.'); return W.A[v]; };
    const done = msg => { W.bch = true; touch(W, u); return { msg }; };
    switch (op) {
      case 'create': {
        if (mine) fail(`You are already in ${mine.name}. Leave it first.`);
        if (rankOf(n.xp) < BLOC.rank) fail('Founding an alliance needs the rank of Mayor.');
        if (n.cash < BLOC.cost) fail(`Founding an alliance costs ${money(BLOC.cost)}.`);
        const name = nameOk(c.name), tag = tagOk(c.tag), id = 'b' + rid();
        n.cash -= BLOC.cost; W.B[id] = { id, name, tag, flag: blocFlag(c.flag), motto: cleanName(c.motto, 0, 80), leader: u, members: [u], created: W.now, bank: 0, contrib: {}, invites: {}, done: {}, proj: null, wall: [], log: [], open: false };
        n.bloc = id; blocLog(W.B[id], `${n.name} founded the alliance.`, W); news(W, u, `${n.name} founded a new alliance: ${name} [${tag}].`); gainXP(W, u, 25);
        return done(`${name} [${tag}] is founded. Invite other leaders from their nation card or the Alliance page.`);
      }
      case 'edit': {
        needLeader(); if (c.name != null) mine.name = nameOk(c.name, mine); if (c.tag != null) mine.tag = tagOk(c.tag, mine); if (c.flag) mine.flag = blocFlag(c.flag); if (c.motto != null) mine.motto = cleanName(c.motto, 0, 80); if (c.open != null) mine.open = !!c.open;
        return done('Alliance updated.');
      }
      case 'invite': {
        needLeader(); const t = peer(String(c.v)); const v = String(c.v); if (v === u) fail('You are already a member.'); if (t.ai) fail('AI nations do not join alliances.');
        if (mine.members.includes(v)) fail(`${t.name} is already a member.`); if (blocOf(W, v)) fail(`${t.name} is already in another alliance.`);
        if (mine.members.length >= blocCap(mine)) fail(`Your alliance is full (${blocCap(mine)} members).`);
        if (rogue(W, t)) fail(`${t.name} is a rogue state.`);
        mine.invites[v] = W.now; note(W, v, 'diplo', `🤝 ${n.name} invites you to join the alliance ${mine.name} [${mine.tag}]. Answer on the Diplomacy page.`); log(t, `${n.name} invited you to join ${mine.name} [${mine.tag}].`, W); touch(W, v);
        return done(`Invitation sent to ${t.name}.`);
      }
      case 'uninvite': { needLeader(); delete mine.invites[String(c.v)]; return done('Invitation withdrawn.'); }
      case 'join': {
        const b = has(W.B, String(c.id)) ? W.B[String(c.id)] : null; if (!b) fail('That alliance no longer exists.');
        if (mine) fail(`You are already in ${mine.name}. Leave it first.`);
        const inv = b.invites && b.invites[u]; if (!b.open && !(inv && W.now - inv < BLOC.inviteH * HOUR)) fail('You need an invitation to join that alliance.');
        if (b.members.length >= blocCap(b)) fail('That alliance is full.'); if (rogue(W, n)) fail('Rogue states cannot join an alliance.');
        const foe = b.members.find(m => W.A[m] && atWar(W, u, m)); if (foe) fail(`You are at war with ${W.A[foe].name}, a member. Make peace first.`);
        delete b.invites[u]; b.members.push(u); n.bloc = b.id; blocLog(b, `${n.name} joined.`, W);
        for (const m of b.members) if (m !== u && W.A[m]) { note(W, m, 'diplo', `🤝 ${n.name} joined your alliance ${b.name}.`); touch(W, m); }
        news(W, u, `${n.name} joined the alliance ${b.name} [${b.tag}].`); return done(`Welcome to ${b.name}!`);
      }
      case 'decline': { const b = has(W.B, String(c.id)) ? W.B[String(c.id)] : null; if (b && b.invites) delete b.invites[u]; return done('Invitation declined.'); }
      case 'leave': {
        if (!mine) fail('You are not in an alliance.'); blocRemove(W, mine, u, `${n.name} left the alliance.`); news(W, u, `${n.name} left the alliance ${mine.name}.`); return done(`You left ${mine.name}.`);
      }
      case 'kick': { needLeader(); const v = String(c.v); if (v === u || !mine.members.includes(v)) fail('Not a member.'); const t = W.A[v]; blocRemove(W, mine, v, `${t ? t.name : 'A nation'} was removed by the leader.`); if (t) { note(W, v, 'diplo', `You were removed from the alliance ${mine.name}.`); touch(W, v); } return done('Member removed.'); }
      case 'lead': { needLeader(); const v = String(c.v); if (!mine.members.includes(v) || v === u) fail('Choose another member.'); mine.leader = v; blocLog(mine, `${W.A[v].name} is the new leader.`, W); note(W, v, 'diplo', `You are now the leader of ${mine.name}.`); touch(W, v); return done(`${W.A[v].name} now leads the alliance.`); }
      case 'disband': { needLeader(); for (const m of [...mine.members]) if (W.A[m]) { W.A[m].bloc = null; touch(W, m); if (m !== u) note(W, m, 'diplo', `The alliance ${mine.name} was disbanded.`); } if (mine.bank > 0) n.cash += mine.bank; news(W, u, `The alliance ${mine.name} has been disbanded.`); delete W.B[mine.id]; return done(`${mine.name} was disbanded${mine.bank > 0 ? `; ${money(mine.bank)} from the treasury went to you` : ''}.`); }
      case 'give': {
        if (!mine) fail('You are not in an alliance.'); const amt = Math.floor(Number(c.amt)); if (!(amt >= 1e5)) fail('Deposit at least $100,000.'); if (amt > n.cash) fail('You do not have that much money.');
        n.cash -= amt; mine.bank = (mine.bank || 0) + amt; mine.contrib[u] = (mine.contrib[u] || 0) + amt; blocLog(mine, `${n.name} deposited ${moneyS(amt)}.`, W); gainXP(W, u, Math.min(30, Math.round(amt / 1e7) + 2));
        return done(`${moneyS(amt)} deposited into the ${mine.name} treasury.`);
      }
      case 'grant': {
        needLeader(); const v = String(c.v); if (!mine.members.includes(v) || !W.A[v]) fail('Choose a member.'); const amt = Math.floor(Number(c.amt)); if (!(amt >= 1e5)) fail('Send at least $100,000.'); if (amt > (mine.bank || 0)) fail('The treasury does not hold that much.');
        mine.bank -= amt; W.A[v].cash += amt; blocLog(mine, `The leader sent ${moneyS(amt)} to ${W.A[v].name}.`, W); if (v !== u) note(W, v, 'diplo', `${mine.name} sent you ${moneyS(amt)} from the alliance treasury.`); touch(W, v);
        return done(`${moneyS(amt)} sent to ${W.A[v].name}.`);
      }
      case 'proj': {
        if (!mine) fail('You are not in an alliance.'); const k = String(c.k); if (!has(BPROJ, k)) fail('Unknown project.'); const P_ = BPROJ[k];
        if (mine.done[k]) fail(`Your alliance already completed the ${P_.n}.`);
        if (mine.proj && mine.proj.k !== k) fail(`Your alliance is building the ${BPROJ[mine.proj.k].n}. Finish it first.`);
        if (!mine.proj && !isLeader) fail('Only the leader can choose a new project. Any member can then build its stages.');
        if (mine.proj && mine.proj.next > W.now) fail(`Stage ${mine.proj.stage} is still being built: next stage in ${fmtT(mine.proj.next - W.now)}.`);
        const cost = blocStageCost(W, mine); if ((mine.bank || 0) < cost) fail(`Each stage costs ${moneyS(cost)} from the alliance treasury (it holds ${moneyS(mine.bank || 0)}).`);
        mine.bank -= cost; const pr = mine.proj || (mine.proj = { k, stage: 0 }); pr.stage++; pr.next = W.now + BLOC.stageH * HOUR; gainXP(W, u, 20);
        if (pr.stage >= P_.stages) { mine.done[k] = W.now; mine.proj = null; blocLog(mine, `${P_.n} completed! ${P_.d}`, W); news(W, u, `The alliance ${mine.name} completed the ${P_.n}.`); for (const m of mine.members) if (W.A[m]) { note(W, m, 'diplo', `🏛 Your alliance completed the ${P_.n}: ${P_.d}`); touch(W, m); } return done(`${P_.n} completed!`); }
        blocLog(mine, `${n.name} built stage ${pr.stage} of ${P_.stages} of the ${P_.n} (${moneyS(cost)}).`, W); return done(`Stage ${pr.stage} of ${P_.stages} built. Next stage in ${BLOC.stageH} hours.`);
      }
      case 'post': {
        if (!mine) fail('You are not in an alliance.'); const x = cleanName(c.text, 1, 1000); if (!x) fail('Write a message first.');
        if ((mine.wall || []).filter(w => w.u === u && W.now - w.t < 20e3).length >= 6) fail('Slow down a little.');
        mine.wall = [{ t: W.now, u, x }, ...(mine.wall || [])].slice(0, BLOC.wall); return done('Posted.');
      }
      default: fail('Unknown alliance action.');
    }
  }
  function blocRemove(W, b, v, why) {
    b.members = b.members.filter(m => m !== v); if (W.A[v]) { W.A[v].bloc = null; touch(W, v); } blocLog(b, why, W);
    if (!b.members.length) { delete W.B[b.id]; return; }
    if (b.leader === v) { const nxt = b.members.filter(m => W.A[m]).sort((x, y) => score(W, y) - score(W, x))[0] || b.members[0]; b.leader = nxt; blocLog(b, `${W.A[nxt] ? W.A[nxt].name : 'A member'} is the new leader.`, W); if (W.A[nxt]) note(W, nxt, 'diplo', `You are now the leader of ${b.name}.`); }
    W.bch = true;
  }
  // keep alliances consistent with the world: fallen nations leave, stale invitations expire, nations point at their real alliance
  function blocTick(W) {
    for (const b of Object.values(W.B)) {
      for (const m of [...b.members]) if (!W.A[m]) blocRemove(W, b, m, 'A member nation has fallen and left the alliance.');
      if (!W.B[b.id]) continue;
      for (const [v, t] of Object.entries(b.invites || {})) if (W.now - t > BLOC.inviteH * HOUR || !W.A[v]) { delete b.invites[v]; W.bch = true; }
      for (const m of b.members) if (W.A[m] && W.A[m].bloc !== b.id) { W.A[m].bloc = b.id; touch(W, m); }
      blocGoalState(W, b);
    }
    for (const [u, n] of Object.entries(W.A)) if (n.bloc && !blocOf(W, u)) { n.bloc = null; touch(W, u); }
  }





  // ---------- decommissioning nuclear weapons ----------
  function decommission(W, u) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!n.nuke) fail('You have no nuclear weapons to decommission.');
    const hadWar = !!n.warhead, back = Math.round(NUKE.cash * DISARM.refund);
    n.nuke = 0; n.warhead = null; n.iaeaAt = 0; n.nukeBan = W.now + DISARM.banD * 864e5; n.cash += back;
    n.approval = clamp(n.approval + DISARM.ap + (hadWar ? DISARM.warheadAp : 0), 0, 100); n.stability = clamp(n.stability + DISARM.st, 0, 100); n.aggr = Math.max(0, (n.aggr || 0) - DISARM.aggr);
    W._src = 'disarm'; applyEff(W, u, { boost: { ...DISARM.boost } }); W._src = ''; gainXP(W, u, DISARM.xp); achGrant(W, u, 'peacemaker');
    for (const [v, x] of Object.entries(W.A)) if (v !== u) { x.approval = clamp(x.approval + DISARM.worldAp, 0, 100); touch(W, v); }
    news(W, u, `☮ ${n.name} has decommissioned its nuclear ${hadWar ? 'arsenal, including an armed warhead' : 'deterrent'}. The world breathes a little easier.`);
    log(n, `Nuclear weapons decommissioned. Materials sold for ${money(back)}; no more upkeep or inspection fees.`, W); touch(W, u);
    return { msg: `☮ Your nuclear ${hadWar ? 'arsenal has' : 'deterrent has'} been decommissioned. Approval +${DISARM.ap + (hadWar ? DISARM.warheadAp : 0)}, stability +${DISARM.st}, aggression −${DISARM.aggr}, and the world's praise adds +${DISARM.boost.ap} approval and +${DISARM.boost.st} stability for ${DISARM.boost.h} hours. ${money(back)} recovered from the materials. No more upkeep or inspection fees. You can't start a new program for ${DISARM.banD} days.` };
  }
  // ---------- nuclear accidents ----------
  function nukeAccident(W, u, rng) {
    const n = W.A[u]; if (!n) return null; const hs = hexesOf(W, u), pool = hs.filter(h => h != n.cap), h = (pool.length ? pool : hs)[Math.floor(rng() * (pool.length ? pool : hs).length)]; if (h == null) return null;
    const lost = Math.round(n.pop * NUKEACC.pop), clean = Math.round(Math.max(5e6, (n.gdp || 0) * NUKEACC.cashPct) / 1e5) * 1e5;
    n.pop -= lost; n.res.food = Math.round((n.res.food || 0) * (1 - NUKEACC.food)); n.res.steel = Math.round((n.res.steel || 0) * (1 - NUKEACC.steel)); n.res.goods = Math.round((n.res.goods || 0) * (1 - NUKEACC.goods)); n.res.oil = Math.round((n.res.oil || 0) * (1 - NUKEACC.oil));
    const paid = Math.max(0, Math.min(clean, n.cash || 0)); n.cash -= paid; if (clean > paid) n.debt = (n.debt || 0) + (clean - paid);
    n.stability = clamp(n.stability - NUKEACC.st, 0, 100); n.approval = clamp(n.approval - NUKEACC.ap, 0, 100); n.health = clamp((n.health == null ? 50 : n.health) - NUKEACC.health, 0, 100);
    n.rad = { h, t: W.now, until: W.now + NUKEACC.h * HOUR, acc: true }; n.nukeAcc = W.now;
    note(W, u, 'war', `☢ NUCLEAR ACCIDENT at ${pname(h)}! A reactor failure has released radiation: ${num(lost)} people lost, crops contaminated (food output −30% for ${NUKEACC.h} hours), stockpiles spent on the clean-up and ${money(clean)} in clean-up costs. Stability −${NUKEACC.st}, approval −${NUKEACC.ap}.`);
    log(n, `Nuclear accident at ${pname(h)}: ${num(lost)} people lost, ${money(clean)} spent on the clean-up.`, W);
    news(W, u, `☢ Nuclear accident in ${n.name}: a reactor failure at ${pname(h)} has released radiation.`); touch(W, u);
    return { h, place: pname(h), name: n.name, lost, clean };
  }
  // ---------- moving the capital ----------
  const capMoveCost = (W, u) => { const n = W.A[u]; return { cash: Math.round((Math.max(CAPMOVE.min, (n.gdp || 0) * CAPMOVE.gdpPct) + (n.dome ? DOME.cash * CAPMOVE.domeX : 0)) / 1e6) * 1e6, steel: CAPMOVE.steel, goods: CAPMOVE.goods, oil: CAPMOVE.oil }; };
  function canMoveCap(W, u, h) {
    const n = W.A[u]; if (!n) return 'Found a nation first.'; h = Number(h); if (!Number.isInteger(h) || !P[h]) return 'Unknown province.';
    if (h == n.cap) return 'This is already your capital.'; if (owner(W, h) !== u) return 'You can only move your capital to one of your own provinces.';
    if (rankOf(n.xp) < CAPMOVE.rank) return 'Moving the capital needs the rank of Mayor.';
    const wait = (n.capMoved || 0) + CAPMOVE.cdH * HOUR - W.now; if (wait > 0) return `You moved your capital recently. You can move it again in ${fmtT(wait)}.`;
    if (hexAge(W, h) * 24 < CAPMOVE.holdH) return `You must hold ${pname(h)} for at least ${CAPMOVE.holdH} hours first.`;
    if (n.unrest && (n.unrest[h] || 0) > W.now) return `Separatists are active in ${pname(h)}.`;
    if ((W.DIS || []).some(x => x.h == h && x.until > W.now)) return `${pname(h)} is a disaster zone.`;
    const c = capMoveCost(W, u); if (n.cash < c.cash || (n.res.steel || 0) < c.steel || (n.res.goods || 0) < c.goods || (n.res.oil || 0) < c.oil) return `Moving the capital costs ${money(c.cash)}, ${num(c.steel)} steel, ${num(c.goods)} goods and ${num(c.oil)} oil.`;
    return '';
  }
  function moveCap(W, u, h, newName) {
    const why = canMoveCap(W, u, h); if (why) fail(why); h = Number(h); const n = W.A[u], c = capMoveCost(W, u), old = n.cap;
    // a new capital, a new era: the nation may take a new name at the same time
    let rename = null; if (typeof newName === 'string' && newName.trim() && newName.trim().replace(/\s+/g, ' ') !== n.name) { const nm = newName.trim().replace(/\s+/g, ' ');
      if (nm.length < 2 || nm.length > 28 || !/^[\p{L}\p{N} .,'&()-]+$/u.test(nm)) fail('Choose a name of 2–28 letters, numbers and basic punctuation.');
      if (Object.entries(W.A).some(([v, x]) => v !== u && x.name.toLowerCase() === nm.toLowerCase())) fail('That name is already in use.'); rename = nm; }
    n.cash -= c.cash; n.res.steel -= c.steel; n.res.goods -= c.goods; n.res.oil -= c.oil;
    n.hexes[old] = n.hexes[old] || n.created; n.hexes[h] = n.hexes[h] || W.now; n.cap = h; n.capMoved = W.now; if (n.conq) delete n.conq[h]; /* the government moving in ends any unrest from conquest */
    n.stability = clamp(n.stability - CAPMOVE.st, 0, 100); n.approval = clamp(n.approval - CAPMOVE.ap, 0, 100); n.morale = clamp((n.morale == null ? 70 : n.morale) - CAPMOVE.morale, 0, 100);
    W._src = 'capital'; applyEff(W, u, { boost: { ...CAPMOVE.weak, h: CAPMOVE.weakH } }); W._src = ''; // the government is in disarray for a day
    const domeMsg = n.dome ? ' Your Golden Dome was left behind and dismantled: build a new one around the new capital.' : '';
    if (n.dome) n.dome = null;
    W.OWN = computeOwn(W.A); W.selHex = h; const oldName = n.name; if (rename) n.name = rename;
    news(W, u, rename ? `${oldName} has moved its capital to ${pname(h)} and renamed itself ${rename}.` : `${n.name} has moved its capital from ${pname(old)} to ${pname(h)}.`);
    log(n, `The capital moved from ${pname(old)} to ${pname(h)} at a cost of ${money(c.cash)}.${domeMsg}`, W); touch(W, u);
    return { msg: `${rename ? `Welcome to ${rename}! ` : ''}${pname(h)} is your new capital. It cost ${moneyS(c.cash)} and materials; stability −${CAPMOVE.st}, approval −${CAPMOVE.ap}, morale −${CAPMOVE.morale}. For ${CAPMOVE.weakH} hours while the government settles in: −20% tax revenue, −15% defense everywhere and −5% GDP. The new capital's defenses are still going up (full capital bonus in ${CAPMOVE.fortH} hours).${domeMsg}` };
  }
  // ---------- trade routes: breaking an old one hurts ----------
  function breakRoute(W, u, v, how) {
    if (!pact(W, u, v, 'trade') && !(how === 'war' && pact(W, u, v, 'ally'))) return; const days = (W.now - routeStart(W, u, v)) / 864e5; if (days < 1) return;
    const me = W.A[u], them = W.A[v], fine = Math.round(Math.min(.05, .01 * days) * Math.max(0, me.cash || 0)); me.cash -= fine; them.cash += fine;
    me.approval = clamp(me.approval - 3, 0, 100); me.stability = clamp(me.stability - 3, 0, 100);
    log(me, `Breaking your ${Math.floor(days)}-day trade route with ${them.name} cost ${money(fine)} in compensation, 3 approval and 3 stability.`, W);
    log(them, `${me.name} broke your ${Math.floor(days)}-day trade route and paid you ${money(fine)} in compensation.`, W); note(W, v, 'diplo', `${me.name} broke your trade route and paid ${money(fine)} in compensation.`); touch(W, v);
  }
  // ---------- province development ----------
  function develop(W, u, h) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); h = Number(h); if (!Number.isInteger(h) || !P[h]) fail('Unknown province.');
    if (owner(W, h) !== u) fail('You can only develop your own provinces.');
    const lvl = devLvl(n, h) + 1; if (lvl > DEV.max) fail(`${pname(h)} is already a metropolis.`);
    if (lvl === 3 && rankOf(n.xp) < 2) fail('Building a city needs the rank of Mayor.'); if (lvl === 4 && rankOf(n.xp) < 3) fail('Building a metropolis needs the rank of Governor.');
    if ((W.DIS || []).some(x => x.h == h && x.until > W.now)) fail(`${pname(h)} is a disaster zone. Rebuild once it recovers.`);
    if (left(W, n, 'dev')) fail(`Your construction crews are busy: ${fmtT(left(W, n, 'dev'))}.`);
    const c = devCost(W, u, lvl); if (n.cash < c.cash || (n.res.steel || 0) < c.steel || (n.res.goods || 0) < c.goods) fail(`Developing to ${DEV.names[lvl]} costs ${money(c.cash)}${c.steel ? `, ${num(c.steel)} steel` : ''}${c.goods ? `, ${num(c.goods)} goods` : ''}.`);
    n.cash -= c.cash; n.res.steel -= c.steel; n.res.goods -= c.goods; n.dev = n.dev || {}; n.dev[h] = lvl; n.cd.dev = W.now + DEV.cdMin * MIN * W.cfg.cd; gainXP(W, u, 8 * lvl);
    log(n, `${pname(h)} was developed into ${DEV.names[lvl] === 'Industry' ? 'an industrial region' : DEV.names[lvl] === 'Farms' ? 'farmland' : 'a ' + DEV.names[lvl].toLowerCase()} (${money(c.cash)}).`, W);
    if (lvl === 4) news(W, u, `${pname(h)} in ${n.name} has grown into a metropolis.`);
    touch(W, u); W.selHex = h; return { msg: `${pname(h)} is now ${DEV.names[lvl] === 'Farms' ? 'farmland' : DEV.names[lvl] === 'Industry' ? 'an industrial region' : 'a ' + DEV.names[lvl].toLowerCase()}: +${Math.round(DEV.prod * 100)}% output, more people and +${DEV.score} score.` };
  }
  // ---------- rebellions: provinces breaking away ----------
  function breakAway(W, u, h, why, free) {
    const n = W.A[u]; if (!n || h == n.cap || owner(W, h) !== u) return false; const l = devLvl(n, h);
    delete n.hexes[h]; if (n.conq) delete n.conq[h]; if (n.unrest) delete n.unrest[h]; if (n.dev) delete n.dev[h]; W.OWN = computeOwn(W.A);
    if (!free) n.stability = clamp(n.stability - 3, 0, 100); (W.breakaways = W.breakaways || []).push({ from: u, h, dev: l, fromName: n.name, free: !!free });
    note(W, u, 'attack', free ? `${pname(h)} broke away because your empire is over its administration capacity. Build Administrative offices, rank up or release land to stop it.` : `⚠ ${pname(h)} has declared independence! Raise stability and garrison your provinces to keep the rest.`);
    news(W, u, `${pname(h)} ${(why || 'declared independence from {n}').replace('{n}', n.name)}.`); touch(W, u); return true;
  }
  // an empire above its province limit: upkeep and unrest every tick; after the warning period its farthest extra provinces rebel and go free
  function overTick(W, u, rng) {
    const n = W.A[u]; if (!n || (n.ai && n.ai.boss)) return false; if (n.overSince) { delete n.overSince; touch(W, u); } // from the old hard limit
    if (overPaused(W)) { if (n.admSince) { delete n.admSince; touch(W, u); } return false; } // penalties paused: the warning clock starts fresh afterwards
    const a = adminState(W, u);
    if (!a.over) { if (n.admSince) { delete n.admSince; touch(W, u); } return false; }
    n.cash -= a.cost; if (n.stability > ADMIN.over.stFloor) n.stability = clamp(n.stability - a.st, ADMIN.over.stFloor, 100); let ch = true;
    if (!a.severe) { if (n.admSince) delete n.admSince; return ch; }
    if (!n.admSince) { n.admSince = W.now; note(W, u, 'attack', `⚠ Your empire is badly over its administration capacity (${a.used} of ${a.cap}). Output is down ${Math.round((1 - a.prodF) * 100)}%, and in ${ADMIN.over.graceH} hours your farthest colonies will start to break away and become free land. Build Administrative offices, rank up, release land, or wait for colonies to become core land.`); return ch; }
    if (W.now - n.admSince >= ADMIN.over.graceH * HOUR && rng() < Math.min(ADMIN.over.pMax, ADMIN.over.p * a.over)) {
      const held = hexesOf(W, u).filter(h => h != n.cap && !(n.outposts && n.outposts[h])), colonies = held.filter(h => (W.now - W.OWN[h].ts) / 864e5 < ADMIN.coreD), pool = colonies.length ? colonies : held;
      const far = pool.sort((x, y) => kmBetween(y, n.cap) - kmBetween(x, n.cap))[0]; if (far != null) breakAway(W, u, far, 'broke away from {n}, whose empire was overstretched, and is now free land', true);
    }
    return ch;
  }
  // Administrative offices: +4 administration capacity per level (up to 5)
  function buildOffice(W, u) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const O = ADMIN.office; if ((n.office || 0) >= O.max) fail('Your administration is fully built.');
    if (left(W, n, 'office')) fail(`Builders are still at work: ${fmtT(left(W, n, 'office'))}.`); const c = officeCost(n);
    if (n.cash < c.cash || (n.res.steel || 0) < c.steel || (n.res.goods || 0) < c.goods) fail(`Administrative offices level ${(n.office || 0) + 1} cost ${money(c.cash)}, ${num(c.steel)} steel and ${num(c.goods)} goods.`);
    n.cash -= c.cash; n.res.steel -= c.steel; n.res.goods -= c.goods; n.office = (n.office || 0) + 1; n.cd.office = W.now + O.cdH * HOUR; gainXP(W, u, 20);
    log(n, `Administrative offices expanded to level ${n.office}: administration capacity +${O.cap}.`, W); touch(W, u); return { msg: `Administrative offices level ${n.office}: +${O.cap} administration capacity (now ${adminCap(n)}).` };
  }
  // season counters: battles won and relief sent while a season is running
  // a season win only counts against a real opponent (at least half your military power) and at most 3 times per target per day, so tiny nations and friends can't be farmed
  const seasonWin = (W, u, v) => { const me = W.A[u], d = W.A[v]; if (!me || !d || !(W.cfg && W.cfg.season)) return; if (power(W, v) < power(W, u) * .5) return; const day = Math.floor(W.now / 864e5); me.ssw = me.ssw && me.ssw.day === day ? me.ssw : { day, t: {} }; if ((me.ssw.t[v] || 0) >= 3) return; me.ssw.t[v] = (me.ssw.t[v] || 0) + 1; seasonBump(W, me, 'wins'); };
  const seasonBump = (W, n, k, v = 1) => { const id = W.cfg && W.cfg.season; if (!id || !n) return; if (!n.ss || n.ss.id !== id) n.ss = { id, wins: 0, relief: 0 }; n.ss[k] = (n.ss[k] || 0) + v; };
  // vassals
  const vassalsOf = (W, u) => Object.keys(W.A).filter(k => W.A[k].overlord === u);
  function endWar(W, a, b) { const t = W.now + 1; setRel(W.A[a], b, 'peace', t); setRel(W.A[b], a, 'peace', t); }
  function independence(W, u) {
    const n = W.A[u]; if (!n || !n.overlord) fail('You are not a vassal.'); const o = W.A[n.overlord];
    if (!o) { delete n.overlord; delete n.vassalT; touch(W, u); return { msg: 'Your overlord is gone: you are free.' }; }
    const lf = (n.vassalT || 0) + VASSAL.freeH * HOUR - W.now; if (lf > 0) fail(`You can declare independence in ${fmtT(lf)}.`);
    const ov = n.overlord; delete n.overlord; delete n.vassalT; setRel(n, ov, 'war', W.now); setRel(o, u, 'war', W.now); n.rel[ov].fair = 1; n.rel[ov].def = 1;
    log(n, `You declared independence from ${o.name}. They will surely fight to keep you.`, W); note(W, ov, 'war', `⚔ Your vassal ${n.name} has declared independence! You are now at war with it.`); news(W, u, `${n.name} has declared independence from ${o.name}. War has broken out.`); touch(W, u, ov);
    return { msg: `You are independent of ${o.name}, and at war with it.` };
  }
  function freeVassal(W, u, v) { const n = W.A[v]; if (!n || n.overlord !== u) fail('That nation is not your vassal.'); delete n.overlord; delete n.vassalT; log(n, `${W.A[u].name} has released you from vassalage. You are free.`, W); note(W, v, 'diplo', `${W.A[u].name} released you. You are no longer a vassal.`); news(W, u, `${W.A[u].name} released ${n.name} from vassalage.`); touch(W, u, v); return { msg: `${n.name} is free.` }; }
  // tribute: half a tax collection and 10% of production every tick

  // COMEBACK SUPPORT: a player who loses more than half their land within a day (not by releasing it) gets help to rebuild
  const COMEBACK = { min: 6, frac: .5, gapH: 72, shieldH: 24, cash: 5e7, perProv: 1.5e7, cashMax: 1e9, troopsF: .3 };
  const shieldOn = (W, n) => !!(n && n.shield && n.shield > W.now);
  const dropShield = n => { if (n && n.shield) delete n.shield; };
  function comebackTick(W, u) {
    const n = W.A[u]; if (!n || n.ai) return false; const cnt = hexesOf(W, u).length; let lh = (n.lh || []).filter(x => W.now - x[0] <= 25 * HOUR);
    if (!lh.length || W.now - lh[lh.length - 1][0] >= HOUR) lh.push([W.now, cnt]); n.lh = lh;
    const peak = Math.max(...lh.filter(x => W.now - x[0] <= 24 * HOUR).map(x => x[1]), cnt);
    if (peak < COMEBACK.min || cnt > peak * COMEBACK.frac || W.now - ((n.cbk && n.cbk.t) || 0) < COMEBACK.gapH * HOUR) return false;
    const lost = peak - cnt, cash = Math.min(COMEBACK.cashMax, COMEBACK.cash + lost * COMEBACK.perProv), room = Math.max(0, troopCap(n) - (n.troops || 0)), tr = Math.min(room, Math.round(troopCap(n) * COMEBACK.troopsF));
    n.cash += cash; n.troops = (n.troops || 0) + tr; n.stability = clamp((n.stability || 0) + 15, 0, 100); n.approval = clamp((n.approval || 0) + 10, 0, 100); n.shield = W.now + COMEBACK.shieldH * HOUR;
    n.cbk = { t: W.now, cash, troops: tr, lost, until: n.shield }; n.lh = [[W.now, cnt]];
    note(W, u, 'war', `🛡 Comeback support: you lost ${lost} provinces in a day, so allies sent ${moneyS(cash)} and ${num(tr)} troops, and the world placed you under protection for ${COMEBACK.shieldH} hours. Attacking anyone ends the protection early.`);
    log(n, `Comeback support arrived: ${money(cash)}, ${num(tr)} troops, +15 stability, +10 approval, and ${COMEBACK.shieldH} hours of protection.`, W); news(W, u, `🛡 ${n.name} is rebuilding under international protection.`); touch(W, u); return true;
  }
  // Rapid redeployment: now and then a stroke of luck clears a player's attack timers
  const RUSH = { p: .016, gapH: 12, maxHv: 12, why: [
    ['🎖', 'A defecting enemy general', 'handed your staff their entire supply schedule. Every unit is rearmed and ready to strike again.'],
    ['🚄', 'Overnight rail miracle', 'Your engineers finished an experimental military railway ahead of schedule, and your armies redeployed in record time.'],
    ['📦', 'The forgotten depot', 'A legendary quartermaster stumbled on a sealed ammunition depot from a past war. The whole army is resupplied.'],
    ['📣', 'A speech for the ages', 'Your address to the troops went viral across the nation. Morale is sky-high and every unit is back on the line.'],
    ['🌒', 'Solar storm', 'A solar storm blinded every spy satellite on Earth, and your commanders used the darkness to regroup unseen.'],
    ['🛩', 'Midnight convoy', 'Friendly smugglers slipped a convoy of fuel, missiles and spare parts across the border overnight.'],
    ['🕵', 'Intercepted orders', 'Your spy chief decoded the enemy’s orders, and your generals rushed every unit back to the front before the window closed.'],
    ['🤖', 'Logistics breakthrough', 'Your scientists automated the supply chain with self-driving trucks and drones. Resupply took minutes, not hours.'],
    ['⚙', 'Factory overdrive', 'Your arms factories ran three shifts straight to replace every missile and shell you fired.'] ] };
  function rushTick(W, u, rng) {
    const n = W.A[u]; if (!n || n.ai || W.now - ((n.rush && n.rush.t) || 0) < RUSH.gapH * HOUR) return false; const cd = n.cd || {}, live = k => (cd[k] || 0) > W.now;
    const keys = ['attack', 'strike', 'covert'].filter(live), hv = Object.keys(HEAVY).filter(k => HEAVY[k].cdH <= RUSH.maxHv && live('hv_' + k)), reg = (n.regroup || 0) > W.now;
    if (!keys.length && !hv.length && !reg) return false; if ((rng || Math.random)() >= RUSH.p) return false;
    for (const k of keys) delete cd[k]; for (const k of hv) delete cd['hv_' + k]; if (reg) n.regroup = 0;
    const w = RUSH.why[Math.floor((rng || Math.random)() * RUSH.why.length)], what = [reg && 'army regrouping', keys.includes('attack') && 'attacks', keys.includes('strike') && 'air & missile strikes', keys.includes('covert') && 'spy operations', ...hv.map(k => HEAVY[k].n.toLowerCase() + 's')].filter(Boolean);
    n.rush = { t: W.now, ic: w[0], title: w[1], why: w[2], what };
    note(W, u, 'war', `${w[0]} Rapid redeployment! ${w[1]}: ${w[2]} Timers cleared: ${what.join(', ')}.`); touch(W, u); return true;
  }
  function tributeTick(W, u) { const n = W.A[u]; if (!n || !n.overlord) return false; const o = W.A[n.overlord]; if (!o) { delete n.overlord; delete n.vassalT; return true; }
    const cash = Math.max(0, Math.round(taxIncome(W, u) * VASSAL.tax)); n.cash -= cash; o.cash += cash; const p = production(W, u); for (const r in p) { const x = Math.min(Math.floor(Math.max(0, p[r]) * VASSAL.res), Math.floor(Math.max(0, n.res[r] || 0))); if (x > 0) { n.res[r] -= x; o.res[r] = (o.res[r] || 0) + x; } }
    o.tribute = (o.tribute || 0) + cash; touch(W, n.overlord); return true; }
  // far-flung provinces (over 3,000 km from the capital) slip away now and then, more often when stability is low
  function farLands(W, u, rng) {
    const n = W.A[u]; if (!n || (n.ai && n.ai.boss) || !P[n.cap]) return false; if (overPaused(W)) { if (n.farWarn) { delete n.farWarn; touch(W, u); } return false; } const held = hexesOf(W, u); if (held.length < OVER.farMin) return false;
    const far = held.filter(h => h != n.cap && !(n.outposts && n.outposts[h]) && kmBetween(h, n.cap) > OVER.farKm); if (!far.length) { if (n.farWarn) { delete n.farWarn; touch(W, u); } return false; }
    // a 24-hour warning first, like overstretch
    if (!n.farWarn) { n.farWarn = W.now; touch(W, u); note(W, u, 'attack', `⚠ ${far.length} of your provinces lie more than ${num(OVER.farKm)} km from your capital. In ${OVER.graceH} hours they may start to declare independence now and then, more often when stability is low. Release them, or keep stability high.`); return true; }
    if (W.now - n.farWarn < OVER.graceH * HOUR) return false;
    if (rng() < OVER.farP * far.length * (1.2 - (n.stability || 0) / 100)) { const h = far.sort((a, b) => kmBetween(b, n.cap) - kmBetween(a, n.cap))[0]; return breakAway(W, u, h, 'was too far from the capital of {n} to govern and declared independence'); }
    return false;
  }
  function neglect(W, u, rng) {
    const n = W.A[u], held = hexesOf(W, u); let hit = false; const ratio = (n.troops || 0) / Math.max(1, held.length * GARRISON), g = ratio >= 1 ? .5 : 1;
    for (const [h, until] of Object.entries(n.unrest || {})) { if (until < W.now || owner(W, h) !== u) { delete n.unrest[h]; continue; } if (rng() < REBEL.spyP * (1 - n.stability / 100) * g) { breakAway(W, u, Number(h), 'rose up with foreign-armed separatists and broke away from {n}'); hit = true; } }
    if (held.length >= REBEL.minProv && n.stability < REBEL.st) {
      const p = REBEL.p * (REBEL.st - n.stability) / REBEL.st * (n.approval < 40 ? 1.5 : 1) * g;
      if (rng() < p) { const far = held.filter(h => h != n.cap).sort((a, b) => kmBetween(b, n.cap) - kmBetween(a, n.cap))[0]; if (far != null && breakAway(W, u, far, 'tired of neglect, declared independence')) hit = true; }
    }
    return hit;
  }
  // a breakaway province becomes a small AI nation (called by the server, never by players)
  function foundRebel(W, id, h, info) {
    if (W.A[id] || owner(W, h)) return false; const P_ = P[h]; let name = `Free State of ${P_.n}`.slice(0, 28); if (Object.values(W.A).some(n => n.name.toLowerCase() === name.toLowerCase())) name = `Republic of ${P_.n}`.slice(0, 28);
    if (Object.values(W.A).some(n => n.name.toLowerCase() === name.toLowerCase())) name = (`${P_.n} ` + Math.floor(W.now / 1000 % 1000)).slice(0, 28);
    const n = W.A[id] = normalize({ v: 4, name, color: info.color || COLORS[0], gov: 'dem', created: W.now - 3 * 864e5, cap: h, hexes: { [h]: W.now }, xp: 320, cash: 6e6, pop: 1.2e5, troops: 700, ships: isCoastal(h) ? 2 : 0, air: 0, spies: 2, tech: Math.max(0, (info.tech || 2) - 2), train: 0, infra: 1, fort: 1, tax: 20, approval: 75, stability: 65, aggr: 0,
      res: { food: 400, oil: 150, steel: 150, goods: 80 }, cd: {}, cnt: {}, lastTick: W.now, nextCard: W.now + 30 * MIN, cards: [], seen: [], log: [], out: [], rel: {}, trades: [], exp: 0, imp: 0, budget: { ...DEFBUDGET }, debt: 0, unemp: 6, infl: 2, health: 50, edu: 50, iq: 50, morale: 80, nextElection: W.now + W.cfg.electionH * HOUR, ai: { p: 'isolationist', rebel: true, from: info.from || null } });
    if (info.dev > 1) n.dev = { [h]: info.dev - 1 }; W.OWN = computeOwn(W.A); n.gdp = gdpTarget(W, id); n.gdpHist = [{ t: W.now, v: n.gdp }]; touch(W, id);
    news(W, id, `${name} has declared independence${info.fromName ? ` from ${info.fromName}` : ''}.`); return name;
  }
  // ---------- the World Games ----------
  const gamesOn = W => !!(W.G && !W.G.over && W.now >= W.G.start && W.now < W.G.end);
  const gamesF = (n, cat) => cat === 'sport' ? 1 + (n.health == null ? 50 : n.health) / 100 : cat === 'science' ? 1 + soft(n.tech, 10) * .06 : 1 + (n.edu == null ? 50 : n.edu) / 100;
  const gamesRank = (G, cat) => Object.entries((G.inv || {})[cat] || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  function gamesCmd(W, u, cat, amt) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!gamesOn(W)) fail('The World Games are not on right now.'); if (!has(GAMES.cats, cat)) fail('Unknown contest.');
    const a = Math.floor(Number(amt)); if (!(a >= GAMES.minGive)) fail(`Invest at least ${money(GAMES.minGive)}.`); if (a > n.cash) fail('You do not have that much money.');
    const G = W.G; G.inv = G.inv || {}; G.inv[cat] = G.inv[cat] || {}; G.spent = G.spent || {}; const pts = Math.round(a * gamesF(n, cat));
    n.cash -= a; G.inv[cat][u] = (G.inv[cat][u] || 0) + pts; G.spent[u] = (G.spent[u] || 0) + a; if (n.ai) G.botSpent = (G.botSpent || 0) + a; W.gch = true; gainXP(W, u, Math.min(30, 2 + Math.round(a / 2e7)));
    const pos = gamesRank(G, cat).findIndex(([v]) => v === u) + 1; touch(W, u);
    return { msg: `${moneyS(a)} invested in the ${GAMES.cats[cat].n} (×${gamesF(n, cat).toFixed(2)} = ${num(pts)} points). You are #${pos}.` };
  }
  function gamesEnd(W) {
    const G = W.G; G.over = W.now; G.results = {}; const won = {};
    for (const [cat, C_] of Object.entries(GAMES.cats)) {
      const top = gamesRank(G, cat).filter(([v]) => W.A[v]).slice(0, 3); G.results[cat] = top.map(([v, p]) => ({ u: v, name: W.A[v].name, pts: p }));
      top.forEach(([v], i) => { const n = W.A[v]; n.medals = n.medals || { g: 0, s: 0, b: 0 }; n.medals['gsb'[i]]++; n.prestige = (n.prestige || 0) + GAMES.prestige[i]; won[v] = (won[v] || 0) + GAMES.prestige[i];
        applyEff(W, v, { boost: { ap: GAMES.ap[i], h: 24 } }); gainXP(W, v, GAMES.xp[i]); note(W, v, 'event', `${['🥇', '🥈', '🥉'][i]} ${['Gold', 'Silver', 'Bronze'][i]} in the ${C_.n}! +${GAMES.prestige[i]} prestige, +${GAMES.ap[i]} approval for 24 hours, ${GAMES.xp[i]} XP.`); touch(W, v); });
    }
    const champ = Object.entries(won).sort((a, b) => b[1] - a[1])[0];
    if (champ) { G.champ = { u: champ[0], name: W.A[champ[0]].name }; applyEff(W, champ[0], { boost: { gdp: 1.03, h: 48 } }); note(W, champ[0], 'event', '🏆 You topped the medal table at the World Games! +3% GDP for 48 hours from tourism.'); }
    return `🏅 The World Games are over.${champ ? ` ${W.A[champ[0]].name} tops the medal table.` : ''} ${Object.entries(G.results).map(([c, r]) => `${GAMES.cats[c].n}: ${r[0] ? '🥇 ' + r[0].name : 'no entries'}`).join(' · ')}.`;
  }
  // ---------- natural disasters ----------
  function disasterHit(W, u, h, kind) {
    const n = W.A[u], K = DISASTER[kind]; if (!n || !K) return null; const lost = Math.round(n.pop * DISASTER.pop);
    n.pop -= lost; n.stability = clamp(n.stability - DISASTER.st, 0, 100); n.res.food = Math.round((n.res.food || 0) * .9); const dl = devLvl(n, h); if (dl > 0) n.dev[h] = dl - 1;
    const rec = { id: rid(), u, name: n.name, h, place: pname(h), kind, t: W.now, until: W.now + DISASTER.h * HOUR, need: Math.round(Math.max(DISASTER.needMin, (n.gdp || 0) * DISASTER.needPct) / 1e5) * 1e5, got: 0, aid: {}, lost };
    note(W, u, 'event', `${K.ic} ${/^[aeiou]/i.test(K.n) ? 'An' : 'A'} ${K.n.toLowerCase()} struck ${pname(h)}: ${num(lost)} people lost, stability −${DISASTER.st}${dl > 0 ? `, and it fell back to ${DEV.names[dl - 1].toLowerCase()}` : ''}. Output there is cut for ${DISASTER.h} hours. Other nations can send relief.`);
    news(W, u, `${K.ic} ${/^[aeiou]/i.test(K.n) ? 'An' : 'A'} ${K.n.toLowerCase()} has struck ${pname(h)} in ${n.name}.`); touch(W, u); return rec;
  }
  function relief(W, u, id, amt) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); const d = (W.DIS || []).find(x => x.id === String(id) && x.until > W.now); if (!d) fail('That disaster appeal has closed.');
    if (d.u === u) fail('You cannot send relief to yourself.'); const v = W.A[d.u]; if (!v) fail('That nation no longer exists.'); if (atWar(W, u, d.u)) fail(`You are at war with ${v.name}.`);
    const a = Math.floor(Number(amt)); if (!(a >= DISASTER.minGive)) fail(`Send at least ${money(DISASTER.minGive)}.`); if (a > n.cash) fail('You do not have that much money.');
    const before = d.aid[u] || 0, pr0 = Math.min(3, Math.floor(before / d.need * 8) / 2), pr1 = Math.min(3, Math.floor((before + a) / d.need * 8) / 2);
    const counts = Math.max(0, Math.min(a, (d.need || 0) - (d.got || 0))); n.cash -= a; v.cash += a; d.aid[u] = before + a; d.got += a; W.disch = true; if (counts > 0) seasonBump(W, n, 'relief', counts); // only relief up to what the disaster needs counts for the season if (pr1 > pr0) n.prestige = Math.round(((n.prestige || 0) + pr1 - pr0) * 10) / 10;
    // every 20% of the appeal you fund lowers your aggression by 1 (up to −5 for funding all of it)
    const ag0 = Math.min(5, Math.floor(before / d.need * 5 + 1e-9)), ag1 = Math.min(5, Math.floor((before + a) / d.need * 5 + 1e-9)), agD = ag1 - ag0; if (agD > 0) n.aggr = Math.max(0, (n.aggr || 0) - agD);
    if (!before) n.approval = clamp(n.approval + 1, 0, 100); xpOnce(W, u, 'rel_' + d.id, 30 * MIN, Math.min(30, 3 + Math.round(a / 1e7)));
    note(W, d.u, 'diplo', `${n.name} sent ${moneyS(a)} in disaster relief for ${d.place}.`); log(v, `${n.name} sent ${money(a)} in disaster relief.`, W); touch(W, d.u);
    if (!d.done && d.got >= d.need) { d.done = W.now; v.pop += Math.round(d.lost * .5); v.stability = clamp(v.stability + 5, 0, 100); news(W, d.u, `The world rallied behind ${v.name}: relief for ${d.place} is fully funded.`); for (const x of Object.keys(d.aid)) if (W.A[x]) note(W, x, 'diplo', `Relief for ${d.place} is fully funded. Thank you!`); }
    touch(W, u); return { msg: `${moneyS(a)} of relief sent to ${v.name}.${pr1 > pr0 ? ` +${pr1 - pr0} prestige.` : ''}${agD > 0 ? ` Aggression −${agD}.` : ''}` };
  }
  // ---------- world crises ----------
  const crisisOn = W => !!(W.CR && W.CR.key && CRISES[W.CR.key] && !W.CR.over && W.now < W.CR.end);
  const crisisGoal = (W, diff) => { let g = 0; for (const n of Object.values(W.A)) g += n.gdp || 0; return Math.round(Math.max(CRISIS.minGoal, g * (CRISIS.diff[diff] || CRISIS.diff.normal)) / 1e6) * 1e6; };
  const crisisRank = cr => Object.entries(cr.contrib || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  function crisisGive(W, u, amt, label) { const cr = W.CR, n = W.A[u]; cr.contrib[u] = (cr.contrib[u] || 0) + amt; if (cr.key !== 'boss') cr.pool = (cr.pool || 0) + amt; W.crch = true; if (n && n.ai) cr.botPool = (cr.botPool || 0) + amt; }
  function crisisCmd(W, u, op, amt, rng) {
    const n = W.A[u]; if (!n) fail('Found a nation first.'); if (!crisisOn(W)) fail('There is no world crisis right now.');
    const cr = W.CR, K = CRISES[cr.key], ch = (cr.choice = cr.choice || {})[u]; cr.contrib = cr.contrib || {};
    if (op === 'exploit') {
      if (ch) fail(ch === 'coop' ? 'You already chose to cooperate.' : 'You already chose to exploit this crisis.');
      cr.choice[u] = 'exploit'; n.aggr = clamp((n.aggr || 0) + CRISIS.exploitAggr * aggrScale(W, u) * .75, 0, 100); let msg;
      if (cr.key === 'aliens') { if (rng() < .4) { n.tech += 2; msg = `Your secret team seized alien technology: +2 tech levels (now ${n.tech}).`; news(W, u, `${n.name} secretly seized technology from the alien probe.`); }
        else { const loss = Math.round((n.cash || 0) * .02); n.cash -= loss; msg = `The secret mission failed and cost ${money(loss)}.`; news(W, u, `${n.name} was caught trying to seize the alien probe for itself.`); } }
      else { const gain = Math.round((n.gdp || 0) * CRISIS.exploitGdp); n.cash += gain; msg = `${K.exploit}: ${money(gain)} earned.`;
        news(W, u, { pandemic: `${n.name} is profiteering from the pandemic by hoarding medicine.`, asteroid: `${n.name} is selling doomsday bunkers instead of helping to stop the asteroid.`, boss: `${n.name} is selling weapons to the Rising Power.` }[cr.key] || `${n.name} is exploiting the crisis.`);
        if (cr.key === 'boss' && cr.boss && W.A[cr.boss]) { const B_ = W.A[cr.boss]; B_.troops = Math.round((B_.troops || 0) * 1.03); touch(W, cr.boss); } }
      W.crch = true; log(n, msg, W); touch(W, u); return { msg };
    }
    if (op === 'coop' || op === 'give') {
      if (ch === 'exploit') fail('You chose to exploit this crisis and cannot join the world effort now.');
      if (!ch) { cr.choice[u] = 'coop'; W.crch = true; news(W, u, `${n.name} joined the world effort against ${K.n}.`); gainXP(W, u, 10); }
      if (op === 'coop' && amt == null) { touch(W, u); return { msg: 'You joined the world effort. Every contribution counts.' }; }
      const a = Math.floor(Number(amt)); if (!(a >= CRISIS.minGive)) fail(`Contribute at least ${money(CRISIS.minGive)}.`); if (a > n.cash) fail('You do not have that much money.');
      n.cash -= a; crisisGive(W, u, a); xpOnce(W, u, 'crisis', 30 * MIN, Math.min(40, 2 + Math.round(a / 2e7))); log(n, `Contributed ${money(a)} to the world effort against ${K.n}.`, W); touch(W, u);
      return { msg: `${moneyS(a)} contributed. ${cr.key === 'boss' ? 'The coalition thanks you.' : `The world effort is at ${Math.min(100, Math.floor((cr.pool || 0) / cr.goal * 100))}%.`}` };
    }
    fail('Unknown action.');
  }
  // fighting the Rising Power during its crisis counts as a contribution: $25,000 per enemy soldier lost, $50M for every province taken
  function crisisHit(W, u, b, v) {
    if (!crisisOn(W) || W.CR.key !== 'boss' || !b || !v || v !== W.CR.boss) return; const cr = W.CR; cr.choice = cr.choice || {}; cr.contrib = cr.contrib || {};
    if (cr.choice[u] === 'exploit') return; if (!cr.choice[u]) cr.choice[u] = 'coop';
    crisisGive(W, u, Math.round((b.lossD || 0) * 25000 + (b.win || b.conquered ? 5e7 : 0)));
  }
  // the crisis ends: rewards or disaster. Returns a summary line for the world.
  function crisisEnd(W, ok, rng) {
    const cr = W.CR, K = CRISES[cr.key]; cr.over = W.now; cr.ok = !!ok; const top = crisisRank(cr).filter(([v]) => W.A[v] && cr.choice[v] !== 'exploit').slice(0, 3); cr.top = top.map(([v, a]) => ({ u: v, name: W.A[v].name, amt: a }));
    const coop = Object.keys(cr.choice || {}).filter(v => W.A[v] && cr.choice[v] === 'coop'), expl = Object.keys(cr.choice || {}).filter(v => W.A[v] && cr.choice[v] === 'exploit');
    const boost = (v, b) => applyEff(W, v, { boost: b });
    if (ok) {
      for (const v of coop) { const n = W.A[v]; if (!(cr.contrib[v] > 0)) continue; gainXP(W, v, 50); boost(v, { gdp: 1.03, ap: 3, h: 24 }); if (cr.key === 'aliens') n.tech += 1; note(W, v, 'event', `${K.ic} ${K.win} Thank you for contributing: +3% GDP and +3 approval for 24 hours${cr.key === 'aliens' ? ', and +1 tech level' : ''}.`); touch(W, v); }
      top.forEach(([v, a], i) => { const n = W.A[v]; const back = Math.round(a * [.5, .35, .25][i]); n.cash += back; gainXP(W, v, [300, 200, 120][i]); if (cr.key === 'aliens') n.tech += 1; achGrant(W, v, 'hero');
        boost(v, { tax: 1.08, st: 4, h: 48 }); note(W, v, 'event', `🏅 You were the #${i + 1} contributor to the world effort against ${K.n}! Reward: ${money(back)} back, ${[300, 200, 120][i]} XP, +8% tax revenue and +4 stability for 48 hours${cr.key === 'aliens' ? ', and another tech level' : ''}.`); touch(W, v); });
      for (const v of expl) { const n = W.A[v]; n.approval = clamp(n.approval - 6, 0, 100); n.stability = clamp(n.stability - 4, 0, 100); note(W, v, 'event', `The world beat ${K.n} without you. Your people are ashamed: approval −6, stability −4.`); touch(W, v); }
      return `${K.ic} ${K.win}${top.length ? ` Heroes of the world: ${top.map(([v], i) => `${i + 1}. ${W.A[v].name}`).join(', ')}.` : ''}`;
    }
    let extra = '';
    if (cr.key === 'pandemic') for (const [v, n] of Object.entries(W.A)) { const half = cr.choice[v] === 'exploit'; n.pop = Math.round(n.pop * (half ? .98 : .96)); boost(v, { gdp: half ? .96 : .92, h: 24 }); touch(W, v); }
    else if (cr.key === 'asteroid') {
      const ids = Object.keys(W.A).filter(v => hexesOf(W, v).length); const v = ids.length ? ids[Math.floor(rng() * ids.length)] : null;
      if (v) { const n = W.A[v], hs = hexesOf(W, v).filter(h => h != n.cap), h = hs.length ? hs[Math.floor(rng() * hs.length)] : n.cap; n.pop = Math.round(n.pop * .85); n.infra = Math.max(0, (n.infra || 0) - 2); n.stability = clamp(n.stability - 10, 0, 100); W.impact = h; extra = ` It struck ${pname(h)} in ${n.name}.`; note(W, v, 'event', `☄️ The asteroid struck ${pname(h)}! 15% of your population was lost, infrastructure −2, stability −10.`); }
      for (const [x, n] of Object.entries(W.A)) { if (cr.choice[x] !== 'exploit') boost(x, { gdp: .9, h: 24 }); touch(W, x); }
    }
    else if (cr.key === 'boss' && cr.boss && W.A[cr.boss]) { const B_ = W.A[cr.boss]; B_.troops = Math.round((B_.troops || 0) * 1.3); touch(W, cr.boss); extra = ' Its army grew 30% stronger.'; }
    for (const v of coop) if (cr.contrib[v] > 0) { gainXP(W, v, 25); note(W, v, 'event', `${K.ic} ${K.lose} You tried: +25 XP for your contribution.`); }
    return `${K.ic} ${K.lose}${extra}`;
  }
  function exec0(W, u, cmd, rng) {
    const c = cmd || {};
    switch (c.c) {
      case 'found': return found(W, u, c, rng);
      case 'act': return act(W, u, String(c.k), c.arg, rng);
      case 'decide': return decide(W, u, String(c.id), c.o, rng);
      case 'attack': return attack(W, u, c.h, c.x, c.air, rng, !!c.vassal);
      case 'strike': return strike(W, u, String(c.v), String(c.kind), String(c.target), c.n, rng);
      case 'nuke': return buildNuke(W, u);
      case 'ntest': return nukeTest(W, u, rng, c.delay);
      case 'warhead': return buildWarhead(W, u);
      case 'law': return setLaw(W, u, String(c.k), !!c.on);
      case 'wonder': return wonder(W, u, String(c.k), !!c.abandon);
      case 'exped': return expedition(W, u, String(c.k));
      case 'mission': return claimMission(W, u, c.i);
      case 'offer': return offer(W, u, String(c.v), c.give, c.want);
      case 'release': return releaseProv(W, u, c.h);
      case 'offerok': return answerOffer(W, u, String(c.id), true);
      case 'offerno': return answerOffer(W, u, String(c.id), false);
      case 'offercancel': return cancelOffer(W, u, String(c.id));
      case 'flag': return setFlag(W, u, c.flag, c.motto);
      case 'dirty': return dirtyBomb(W, u, c.v, rng);
      case 'heavy': return heavy(W, u, String(c.v), String(c.k), rng);
      case 'office': return buildOffice(W, u);
      case 'independence': return independence(W, u);
      case 'freevassal': return freeVassal(W, u, String(c.v));
      case 'color': return setColor(W, u, c.color);
      case 'launch': return launchNuke(W, u, String(c.v), c.h, rng);
      case 'dome': return buildDome(W, u);
      case 'mun': return makeMun(W, u, c.q);
      case 'dip': return dip(W, u, String(c.kind), String(c.v));
      case 'aid': return aid(W, u, String(c.v), c.amt || {});
      case 'market': return market(W, u, String(c.r), c.q, !!c.buy);
      case 'autobuy': return setAutoBuy(W, u, c);
      case 'tax': return setTax(W, u, c.t);
      case 'budget': return setBudget(W, u, c.b || {});
      case 'bonds': return bonds(W, u, c.amt, !!c.repay);
      case 'gov': return setGov(W, u, String(c.g));
      case 'covert': return covert(W, u, String(c.op), String(c.v), rng);
      case 'casino': return casino(W, u, c, rng);
      case 'outpost': return buildOutpost(W, u, c.h);
      case 'outpostrm': return dropOutpost(W, u, Number(c.h));
      case 'bloc': return blocCmd(W, u, String(c.op || ''), c);
      case 'crisis': return crisisCmd(W, u, String(c.op || ''), c.amt, rng);
      case 'develop': return develop(W, u, c.h);
      case 'movecap': return moveCap(W, u, c.h, c.name);
      case 'disarm': return decommission(W, u);
      case 'domeup': return domeUp(W, u);
      case 'games': return gamesCmd(W, u, String(c.cat || ''), c.amt);
      case 'relief': return relief(W, u, c.id, c.amt);
      case 'hideguide': { const n = W.A[u]; if (n) { n.hideGuide = true; touch(W, u); } return { msg: '' }; }
      default: fail('Unknown command.');
    }
  }
  // every command passes through here so daily missions and achievements can follow along
  function exec(W, u, cmd, rng) {
    const pre = cmd && cmd.c === 'attack' ? owner(W, Number(cmd.h)) : null, r = exec0(W, u, cmd, rng), c = cmd || {}, n = W.A[u]; if (!n || c.c === 'found') return r;
    try {
      const t = n.tally = n.tally || {};
      if (c.c === 'act') { mTrack(W, u, 'ops', 1); blocGoal(W, u, 'ops'); if (['tax', 'prod', 'research', 'expand', 'recruit', 'infra'].includes(c.k)) mTrack(W, u, c.k, 1); }
      else if (c.c === 'decide') { mTrack(W, u, 'decide', 1); blocGoal(W, u, 'dec'); }
      else if (c.c === 'market') { const q = Math.floor(Number(c.q)) || 0; mTrack(W, u, c.buy ? 'import' : 'export', q); n.cnt.trades = (n.cnt.trades || 0) + 1; }
      else if (c.c === 'aid') mTrack(W, u, 'aid', 1);
      else if (c.c === 'attack' && r && r.battle) { crisisHit(W, u, r.battle, pre); if (r.battle.win || r.battle.conquered) { t.wins = (t.wins || 0) + 1; mTrack(W, u, 'win', 1); } if (r.battle.conquered) { t.caps = (t.caps || 0) + 1; } }
      mState(W, u); achCheck(W, u);
    } catch (e) { }
    return r;
  }


  return { AUTOBUY, autoUnit, autoBuyTick, MUN, munLeft, munRoom, gapF, hvScale, rName, ADMIN, VASSAL, COMEBACK, comebackTick, shieldOn, OUTPOST, outpostCheck, outpostCost, outpostDef, RUSH, CASINO, casinoMax, bjVal, rushTick, starterRoom, overPaused, adminCap, adminState, provAdmin, adminF, officeCost, vassalsOf, OVER, overTick, farLands, holdF, startStrict, startDist, ACH_TIER, ACH_XP, RANK_TAX, promoCash, achGrant, HEAVY, canHeavy, heavyCostTxt, domeLvl, domeMis, domeNuke, canDomeUp, nukeAccident, capMoveCost, canMoveCap, devLvl, devTotal, devCost, routeW, routeStart, tradeVal, gamesOn, gamesF, gamesRank, gamesEnd, disasterHit, foundRebel, breakAway, crisisOn, crisisGoal, crisisRank, crisisEnd, crisisGive, blocOf, sameBloc, blocCap, blocStageCost, blocGoalReward, blocGoalState, blocScore, blocTick, AIRBORNE, airborneOk, P, CN, land, sea, nbrs, pname, measure, pactWar, defending, hitRecently, maxMissiles, NTEST, oceanSite, oceanName, setLandTest, DOME, domeOn, canDome, getCard, orderMult, orderEdge, lawSlots, lawCost, wonderHolder, missionsFor, mReward, fxMul, fxAdd, tcap, STAGE_H, canDeal, bundleTxt, achCheck, rogue, ROGUE_AT, ROGUE_MIN, AI_AGGR_CAP, RELEASE, PROV_MAX, provCheck, BOOST_KEYS, boostTxt, DIRTY, canDirty, INSPECT, inspectFee, OVER, overAt, overstretch, BRIBE, bribeNeeded, bribePrice, bribeRecent, radOn, airBatch, navyBatch, aggrScale, rogueCheck, nuked, nukeF, canWarhead, canLaunch, warheadReady, WARHEAD, devAid, canStrike, bestGen, genF, streakMult, GARRISON, MISSILE, NUKE, GEN_TYPES, CHAINS, troopCap, soft, reach, attackPlan, kmBetween, world, mods, computeOwn, owner, hexesOf, rankOf, rankName, maxHex, R, atWar, warSince, pact, offered, others, wars, allies, traders, embargoed, sanctioned, oilF, cheap, power, score, isCoastal, hasCoast,
    noLimit: () => NOADM, budget, domeUpkeep, debtRatio, rating, interestRate, gdpTarget, taxIncome, spendPerTick, upkeep, production, consumption, popCap, prices, spreads, maxBorrow,
    recruitBatch, navyBatch, airBatch, spyCap, expandCost, settleCost, actCheck, researchCost, maxTrain, infraCost, fortCost, rallyCost, campaignCost, dailyGrant, left, expandTargets, startOk, hexAge, route, canAttack, defense, navalDefense, atkMult, atkCost, techF, moraleF,
    condOk, normalize, exec, tick, startEvent, applyEff, fmtT, log, news, note, touch, setRel, CARDS };
}
return { CHAMP_COLORS, CHAMP_COLOR_NAMES, isChampion, Core, DISARM, NUKEACC, CAPMOVE, DEV, GAMES, DISASTER, REBEL, CRISIS, CRISES, BLOC, BPROJ, LAWS, WONDERS, EXPEDS, MISSIONS, ACH, FLAG_LAYOUTS, FLAG_EMBLEMS, FLAG_COLORS, FLAG_HEX, flagSVG, AUTO_TAX, CHAINS, NUKE, WARHEAD, GEN_TYPES, MIN, HOUR, TICK, TICKS_PER_YEAR, RES, TYPE, CAPP, RANKS, GOV, COLORS, ACTS, DEFCFG, DEFBUDGET, EFFKEYS, COVERT, RESOLUTIONS, EVENTS, money, moneyS, num, clamp };
});
