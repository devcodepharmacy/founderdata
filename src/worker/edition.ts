// Which edition this build is (docs/PRO.md). Core ships `pro = null`. FounderData Pro adds the pro/ folder and changes
// this one file to `export { pro } from '../../pro/worker';`. No other file in core differs between the editions.
import type { Pro } from './pro-hooks';

export const pro: Pro | null = null;
