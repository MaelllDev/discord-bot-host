/**
 * Serializa tarefas pela chave (normalmente o slug da aplicação), garantindo que
 * dois deploys da mesma app nunca rodem ao mesmo tempo — mas apps diferentes
 * seguem em paralelo.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => task(),
      () => task(),
    );
    // A cauda nunca rejeita: uma falha não deve travar a fila daquela chave.
    const tail: Promise<void> = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    try {
      return await current;
    } finally {
      // Só limpa se ninguém entrou na fila depois de nós.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
