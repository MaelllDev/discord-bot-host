import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Pacotes binários minúsculos para os testes de extração.
 *
 * Os de 7z/RAR são os arquivos de teste do libarchive (`libarchive/test/*.7z.uu`
 * e `*.rar.uu`, BSD-2-Clause), decodificados do uuencode e embutidos em base64.
 * O `.tar.xz` é um tarball comum comprimido com `xz`.
 *
 * Só ficam aqui os formatos que não dá para montar em processo: TAR puro e
 * TAR.GZ saem de `makeTar()` + `zlib.gzipSync()` nos próprios testes (ver
 * `helpers/tar.ts`), e o `.tgz` é o mesmo pacote com outra extensão.
 */
const FIXTURES = {
  /** 7z com um arquivo: `file1`. */
  "7z-copy": {
    extension: ".7z",
    data: "N3q8ryccAANBxn2IPAAAAAAAAABCAAAAAAAAAIPbi2MgICAgICAgICAgICAgICAgICAgICAgICAgIGZpbGUgMSBjb250ZW50cwpoZWxsbwpoZWxsbwpoZWxsbwoBBAYAAQk8AAcLAQABAQAMPAAICgGqHd4PAAAFARENAGYAaQBsAGUAMQAAABQKAQCA1kAAqLKdARUGAQAgAAAAAAA=",
  },
  /**
   * 7z com uma raiz única (`meu-bot/`), no formato que sai do GitHub — usado
   * para provar que a pasta raiz também é removida nos formatos 7z/RAR.
   */
  "7z-root": {
    extension: ".7z",
    data: "N3q8ryccAASpteXK1AAAAAAAAAAiAAAAAAAAAN/L4VgBADBjb25zb2xlLmxvZygnYm90Jyk7CnJlcXVlc3RzCmV4cG9ydCBjb25zdCB4ID0gMTsKAAAAgTMHrg/RTICooJCgd17FQBiNa91HrZvHtIDQSi8ecTsSmwky+obi9EAaqC4TbuGSADwkZ4VBoy8zemN+9UUOg0fnkN5PH11TkCt3AZnn1HUqGt8EOJmqpM3TCuxunjRfRyVZTvsA+N6WtYhTcjFwKljZBelJpMM5sdZnE48qQlcbCbUJmaw/QGMCgdwqQgKcsW6WDtxfn4rhKAAAABcGNQEJgJ8ABwsBAAEjAwEBBV0AEAAADIEqCgEHP4kJAAA=",
  },
  /** 7z com `file1` e um link simbólico `symlinkfile`. */
  "7z-symlink": {
    extension: ".7z",
    data: "N3q8ryccAAPLzxX1fAAAAAAAAAAgAAAAAAAAAF2vxPQANBlJ7o6G8ydc2QZdT8nvOjgAAACBMweuD88n8IwHyEOAg4Fb/6yAHVAaA5GArXqzK1bBOJqT9TgqfDHKa6CCsX5KF6ZfsD+wxsTJ7Ii2tsOzc1KGoDhZpeBN7DtLN9AcvxQWKd5Zr4D6HcRgpcjmDJ09VGAo7vKNDAAAFwYTAQlpAAcLAQABIwMBAQVdABAAAAx2CgHhwO8aAAA=",
  },
  /** 7z com o arquivo `bar.txt` criptografado. */
  "7z-encrypted": {
    extension: ".7z",
    data: "N3q8ryccAAOCr+qIEAAAAAAAAABhAAAAAAAAAFj/bGq5DYjQrC1ro1q75TXf0UHZAQQGAAEJEAAHCwEAAiQG8QcBClMH2WRtZJq/DtUjAwEBBV0AAAEAAQAMCAQACAoBqGUyfgAABQEREQBiAGEAcgAuAHQAeAB0AAAAFAoBAACGNqh5sM4BFQYBACCAtIEAAA==",
  },
  /** RAR5 com o arquivo `helloworld.txt`. */
  "rar-stored": {
    extension: ".rar",
    data: "UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAA4MAZjLAIDC50ABJ0ApIMCtEOglYAAAQ5oZWxsb3dvcmxkLnR4dAoDE34Oq1tW6Q4aaGVsbG8gbGliYXJjaGl2ZSB0ZXN0IHN1aXRlIQodd1ZRAwUEAA==",
  },
  /** RAR5 com `file.txt` e dois links simbólicos (`symlink.txt` e `dirlink`). */
  "rar-symlink": {
    extension: ".rar",
    data: "UmFyIRoHAQAzkrXlCgEFBgAFAQGAgACEvYyuHgIChQAGhQCkgwI4jbdcIReTfYBAAQhmaWxlLnR4dDEyMzQKYxpTOS0CAw0ABgjtwwJXjbdcAAAAAIBAAQtzeW1saW5rLnR4dAwFAQAIZmlsZS50eHSOuvx1JAIDCAAGA+3DAkmWt1wAAAAAgEABB2RpcmxpbmsHBQEBA2RpcqP/f8YXAgIABwDtgwFGlrdcAAAAAIAAAQNkaXIdd1ZRAwUEAA==",
  },
  /** RAR4 com `a.txt`/`c.txt` em claro e `b.txt`/`d.txt` criptografados. */
  "rar-encrypted": {
    extension: ".rar",
    data: "UmFyIRoHAM+QcwAADQAAAAAAAAAqY3QgkCoAEgAAABIAAAACVW5a7mRXdlgdMAUAIAAAAGEudHh0APD8TBtUaGlzIGlzIGZyb20gYS50eHRfjnQklDIAIAAAABIAAAAChRT6qWdXdlgdMwUAIAAAAGIudHh0vgIbmnkqilUAsHKgNMn59g0Qf6jR1nzr1KS2yNRrgooen66wDfjatsdECurku8d0IJAqABIAAAASAAAAAjU9mpRuV3ZYHTAFACAAAABjLnR4dACwPkgtVGhpcyBpcyBmcm9tIGMudHh07cp0JJQyACAAAAASAAAAAiXhuiZNZHZYHTMFACAAAABkLnR4dK/ifRPzpVNSAPD7YY92+D/JR2gbUC02jMB4ydOpRar2iQPcvhjgjGZX2wT16cQ9ewBABwA=",
  },
  /** TAR.XZ com raiz única (`meu-bot/`) — xz não existe no Node, então é embutido. */
  "tar-xz": {
    extension: ".tar.xz",
    data: "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AOxdADaZSw0AeMVPU+M9ChgrHFmtHBW15WkO7v8dbGKVJimvCZXXU7fVFKD90jzJ82PXFrxUhynbLt64YVZkiiaWrqNb5AdYzEIOgbKuZb3TG4q4f2OS2bq6xHgHLErjyRtzAere91c7HKm8IB5k1/yiOOByRxclKbfYb8TGHNkm2OKb1h+uSgXXUqXcG+LIq0+1+nI+7W9ptvvQQyes1sSFYPP7qZ9MTL9++0TBqHi0VPchS9Z57XHP0eYLOn3a4WXDjCS1bP6MIx58gMPK6DlWv6VDTFzf08AhT+6Tfz6GYNYgsr/0S0iI9K2UAIgAAN6bLqOwdk1oAAGIAoBQAACDiZPKscRn+wIAAAAABFla",
  },
} as const;

export type ArchiveFixture = keyof typeof FIXTURES;

/** Escreve um fixture em `dir` com a extensão correta e devolve o caminho. */
export async function writeArchiveFixture(dir: string, fixture: ArchiveFixture): Promise<string> {
  const entry = FIXTURES[fixture];
  const target = path.join(dir, `fixture-${fixture}${entry.extension}`);
  await fsp.writeFile(target, Buffer.from(entry.data, "base64"));
  return target;
}
