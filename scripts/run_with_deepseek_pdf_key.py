#!/usr/bin/env python3
import os
import re
import sys

try:
    from pypdf import PdfReader
except ImportError:
    from PyPDF2 import PdfReader


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: run_with_deepseek_pdf_key.py <key-doc.pdf> <command> [args...]")
    pdf_path = sys.argv[1]
    command = sys.argv[2:]
    text = "\n".join((page.extract_text() or "") for page in PdfReader(pdf_path).pages)
    match = re.search(r"DeepSeek.{0,200}?(sk-[A-Za-z0-9_-]{20,})", text, re.IGNORECASE | re.DOTALL)
    if not match:
        raise SystemExit("未在 PDF 中找到 DeepSeek API Key")
    environment = os.environ.copy()
    environment["DEEPSEEK_API_KEY"] = match.group(1)
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    main()
