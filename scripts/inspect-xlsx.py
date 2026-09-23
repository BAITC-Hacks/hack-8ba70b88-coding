"""Read-only workbook inspection. Writes metadata/selected cells only to stdout."""
import argparse
import datetime
import json
from pathlib import Path

import openpyxl

parser = argparse.ArgumentParser()
parser.add_argument("directory")
parser.add_argument("--output")
parser.add_argument("--head", type=int, default=15)
args = parser.parse_args()

result = []
for path in sorted(Path(args.directory).glob("*.xlsx")):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    file = {"file": path.name, "sheets": []}
    for ws in wb.worksheets:
        rows = []
        nonempty = 0
        for index, row in enumerate(ws.iter_rows(values_only=True), start=1):
            populated = [[n + 1, v.isoformat() if isinstance(v, (datetime.date, datetime.datetime)) else v] for n, v in enumerate(row) if v is not None]
            if populated:
                nonempty += 1
                if len(rows) < args.head:
                    rows.append({"row": index, "values": populated})
        file["sheets"].append({"sheet": ws.title, "rows": ws.max_row, "columns": ws.max_column, "nonemptyRows": nonempty, "head": rows})
    wb.close()
    result.append(file)
rendered = json.dumps(result, ensure_ascii=False, indent=2)
if args.output:
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(rendered, encoding="utf-8")
else:
    print(rendered)
