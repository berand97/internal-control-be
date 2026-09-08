export interface PaginationMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface PaginatedResult<T> {
  readonly items: ReadonlyArray<T>;
  readonly pagination: PaginationMeta;
}

export const paginatedResult = <T>(
  items: ReadonlyArray<T>,
  page: number,
  pageSize: number,
  totalItems: number,
): PaginatedResult<T> => ({
  items,
  pagination: {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  },
});
