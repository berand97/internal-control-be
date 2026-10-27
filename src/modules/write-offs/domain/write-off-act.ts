import { formatMoney } from '../../inventories/domain/inventory-act.js';
import { longSpanishDate } from '../../loans/domain/loan-dates.js';
import { WRITE_OFF_ITEM_STATE_LABELS, type WriteOffItemState } from './write-off.js';

export interface WriteOffActItem {
  readonly assetId: string;
  readonly quantity: number;
  readonly state: WriteOffItemState;
  readonly notes: string | null;
  readonly costCenter: string;
  readonly acquisitionDocument: string | null;
  readonly acquisitionDate: string | null;
  readonly acquisitionPrice: number | null;
}

export interface WriteOffActInput {
  readonly authorizedTotal: number;
  readonly observations: string | null;
  readonly councilAgreementNumber: string | null;
  readonly councilAgreementDate: string | null;
  readonly vicefinanceReports: string | null;
  readonly items: ReadonlyArray<WriteOffActItem>;
}

export interface WriteOffActContent {
  readonly fields: Record<string, string>;
  readonly assetFields: Record<string, Record<string, string>>;
}

const cents = (value: number): number => Math.round(value * 100);

export const reportTotal = (prices: ReadonlyArray<number | null>): number =>
  prices.reduce<number>((total, price) => total + cents(price ?? 0), 0) / 100;

export const totalsOf = (
  prices: ReadonlyArray<number | null>,
  authorized: number | null,
): { readonly report: number; readonly authorized: number | null; readonly difference: number | null } => {
  const report = reportTotal(prices);
  return { report, authorized, difference: authorized === null ? null : (cents(authorized) - cents(report)) / 100 };
};

export const buildWriteOffActContent = (input: WriteOffActInput): WriteOffActContent => {
  const totals = totalsOf(
    input.items.map((item) => item.acquisitionPrice),
    input.authorizedTotal,
  );
  return {
    fields: {
      totalInforme: formatMoney(totals.report),
      totalAutorizado: formatMoney(totals.authorized),
      diferencia: formatMoney(totals.difference),
      nota: input.observations?.trim() ?? '',
      acuerdoConsejo: input.councilAgreementNumber?.trim() ?? '',
      fechaAcuerdo: input.councilAgreementDate ? longSpanishDate(input.councilAgreementDate) : '',
      informesVicefinanciera: input.vicefinanceReports?.trim() ?? '',
    },
    assetFields: Object.fromEntries(
      input.items.map((item) => [
        item.assetId,
        {
          cantidad: String(item.quantity),
          documento: item.acquisitionDocument ?? '',
          centro: item.costCenter,
          fechaCompra: item.acquisitionDate ?? '',
          precioCompra: formatMoney(item.acquisitionPrice),
          estado: WRITE_OFF_ITEM_STATE_LABELS[item.state],
          observaciones: item.notes?.trim() ?? '',
        },
      ]),
    ),
  };
};
