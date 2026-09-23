"""Generic read-only full row audit of a supplier's six XLSX export types."""
import collections
import datetime
import json
import re
import sys
from pathlib import Path
import openpyxl

root = Path(sys.argv[1])
result = []
for path in sorted(root.glob('*.xlsx')):
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in book.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        head = [str(x or '') for x in rows[0]]
        stats = {'file': path.name, 'sheet': sheet.title, 'dataRows': len(rows)}
        codes = collections.Counter()
        blanks = 0
        if head[0] == 'Дата':
            dates = collections.Counter()
            warehouses = collections.Counter()
            docs = collections.Counter()
            signs = collections.Counter()
            months = collections.defaultdict(lambda: {'rows':0,'positive':0,'negative':0})
            productMonths = collections.defaultdict(lambda: {'positive':0,'negative':0})
            for idx,row in enumerate(rows[1:],2):
                code = str(row[3] or '').strip()
                codes[code] += 1
                m = re.search(r'(\d{2})\.(\d{2})\.(\d{4})', str(row[0]))
                if m:
                    date = '-'.join([m[3],m[2],m[1]])
                    dates[date] += 1
                    qty = row[7] or 0
                    month = date[:7]
                    sign = 'positive' if qty >= 0 else 'negative'
                    months[month]['rows'] += 1
                    months[month][sign] += qty
                    productMonths[code + '|' + month][sign] += qty
                    doc = re.sub(r'\s+\d.*','',str(row[2]))
                    docs[doc] += 1
                    signs[sign] += 1
                warehouses[str(row[6])] += 1
            stats.update({'dateMin': min(dates), 'dateMax': max(dates),'warehouses': warehouses, 'documents':docs,'signs': signs,'months':months, 'productMonths':productMonths})
        elif head[0] == 'Номенклатура':
            codeCol = next(i for i,v in enumerate(head) if 'Код' in v)
            monthCols = [i for i,v in enumerate(head) if re.search(r'20\d{2}',v)]
            numbers = collections.Counter()
            absent = 0
            for row in rows[1:]:
                code = str(row[codeCol] or '').strip()
                if not code: absent += 1; continue
                codes[code] += 1
                for col in monthCols:
                    v = row[col]
                    numbers['blank' if v is None else 'zero' if v == 0 else 'negative' if isinstance(v,(int,float)) and v < 0 else 'positive' if isinstance(v,(int,float)) else 'other'] += 1
            stats.update({'noCodeRows':absent, 'monthlyCells': numbers})
        elif 'MOQ' in path.name:
            for row in rows[1:]:
                codes[str(row[1] or '').strip()] += 1
            stats['constraints'] = dict(collections.Counter(str(row[4]) for row in rows[1:]))
        elif head[0] == 'Код 1с':
            active = set(); lots = 0; negative = 0; units = []
            for idx,row in enumerate(rows[1:],2):
                code = str(row[0] or '').strip()
                codes[code] += 1
                if any(isinstance(x,(int,float)) and x != 0 for x in row[3:]): active.add(code)
                for col,v in enumerate(row[3:],4):
                    if isinstance(v,(int,float)) and v:
                        lots += 1
                        negative += v < 0
                if 'БУХТ' in str(row[2]).upper(): units.append({'row':idx,'code':code,'values':row[3:]})
            stats.update({'activeInboundProducts':len(active),'lots':lots,'negativeLots':negative,'conversionWarnings':units})
        else:
            stats['allCells'] = [[i+1,list(r)] for i,r in enumerate(rows)]
        stats.update({'uniqueCodes':len(codes),'blankCodeRows':codes.get('',0),'duplicateCodes':dict((k,v) for k,v in codes.items() if v>1), 'codes':list(codes)})
        result.append(stats)
    book.close()
Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)
Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
