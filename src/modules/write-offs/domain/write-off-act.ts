import { formatMoney } from '../../inventories/domain/inventory-act.js';
import { valuationOf } from '../../inventories/domain/inventory-valuation.js';
import { type WriteOffReason, writeOffReasonText } from './write-off.js';

export const WITHOUT_DEPRECIATION = 'sin depreciación';

export interface WriteOffActAsset {
  readonly id: string;
  readonly serialNumber: string | null;
  readonly acquisitionDate: string | null;
  readonly acquisitionPrice: number | null;
  readonly depreciatedValue: number | null;
}

export interface WriteOffActInput {
  readonly reason: WriteOffReason;
  readonly reasonDetail: string | null;
  readonly technicalConcept: string;
  readonly finalDisposition: string;
  readonly observations: string | null;
  readonly valuationDate: string;
  readonly assets: ReadonlyArray<WriteOffActAsset>;
}

export interface WriteOffActContent {
  readonly fields: Record<string, string>;
  readonly assetFields: Record<string, Record<string, string>>;
}

const sum = (values: ReadonlyArray<number | null>): number | null =>
  values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);

export const bookValueText = (asset: Pick<WriteOffActAsset, 'acquisitionPrice' | 'depreciatedValue'>): string => {
  const valuation = valuationOf(asset.acquisitionPrice, null, asset.depreciatedValue);
  if (valuation.bookValue !== null) {
    return formatMoney(valuation.bookValue);
  }
  if (asset.acquisitionPrice === null) {
    return formatMoney(null);
  }
  return `${formatMoney(asset.acquisitionPrice)} ${WITHOUT_DEPRECIATION}`;
};

export const buildWriteOffActContent = (input: WriteOffActInput): WriteOffActContent => {
  const shown = input.assets.map((asset) => asset.depreciatedValue ?? asset.acquisitionPrice);
  const withoutDepreciation = input.assets.filter((asset) => asset.depreciatedValue === null).length;
  return {
    fields: {
      motivo: writeOffReasonText(input.reason, input.reasonDetail),
      motivoCodigo: input.reason,
      conceptoTecnico: input.technicalConcept.trim(),
      disposicionFinal: input.finalDisposition.trim(),
      observaciones: input.observations?.trim() || 'Sin observaciones',
      fechaValor: input.valuationDate,
      totalCosto: formatMoney(sum(input.assets.map((asset) => asset.acquisitionPrice))),
      totalValorLibros: formatMoney(sum(shown)),
      activosSinDepreciacion: String(withoutDepreciation),
    },
    assetFields: Object.fromEntries(
      input.assets.map((asset) => [
        asset.id,
        {
          serial: asset.serialNumber ?? '',
          fechaAdquisicion: asset.acquisitionDate ?? '',
          costo: formatMoney(asset.acquisitionPrice),
          valorLibros: bookValueText(asset),
        },
      ]),
    ),
  };
};
