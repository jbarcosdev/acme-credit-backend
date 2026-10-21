export interface SqlTx {
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: any[]
  ): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: any[]): Promise<number>;
}

export interface SqlDb extends SqlTx {
  $transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}
