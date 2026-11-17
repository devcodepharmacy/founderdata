// Which edition this build is (docs/PRO.md). Core ships `proUi = null`. FounderData Pro adds the pro/ folder and changes
// this one file to `export { proUi } from '../../pro/dashboard';`. No other file in core differs between the editions.
import type { ProUi } from './lib/pro';

export const proUi: ProUi | null = null;
