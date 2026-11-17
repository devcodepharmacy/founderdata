import { ProSlot } from './ProSlot';
import type { AsaKind } from '../lib/asaDims';

/**
 * An Apple Search Ads campaign, ad group or keyword id shown by its name. FounderData Pro looks the name up
 * (pro slot `asaName`); core shows the id, or `name` when the row already carries one.
 */
export function AsaName({ kind, id, name }: { kind: AsaKind; id: string | null; name?: string | null }) {
  const plain = id ? <>{name ?? id}</> : <span className="text-stone-400">(none)</span>;
  return <ProSlot name="asaName" kind={kind} id={id} shown={name} fallback={plain} loading={plain} />;
}
