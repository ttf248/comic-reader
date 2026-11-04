"""按行结束符无关的方式替换文件内容。

仓库里同时存在 LF 与 CRLF 文件（.gitattributes 只约束 .bat），
直接用含 \\n 的字面量替换 CRLF 文件会匹配失败。
这个脚本先归一化再替换，最后按原文件的行结束符写回。
"""

import io
import sys


def edit(path, pairs, newline=None):
    with open(path, "rb") as handle:
        raw = handle.read()
    text = raw.decode("utf-8")
    detected = "\r\n" if "\r\n" in text else "\n"
    normalized = text.replace("\r\n", "\n")
    for old, new in pairs:
        if old not in normalized:
            raise SystemExit("pattern not found in %s:\n%s" % (path, old[:200]))
        normalized = normalized.replace(old, new, 1)
    if newline is not None:
        detected = newline
    out = normalized.replace("\n", detected)
    with open(path, "wb") as handle:
        handle.write(out.encode("utf-8"))
    return detected


if __name__ == "__main__":
    print("import this module instead")
