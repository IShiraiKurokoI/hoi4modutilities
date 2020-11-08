function generate(name) {
    const en = require('../out/i18n/en');
    const zhCn = require('../out/i18n/' + name);
    const fs = require("fs");

    const result = { ...en, ...zhCn };

    fs.writeFileSync('./i18n/' + name + '.ts',
        `import { __table } from './en';\r\n/*eslint sort-keys: "warn"*/\r\nconst table: Partial<typeof __table> = ` +
        JSON.stringify(result, Object.keys(result).sort(), 4) +
        `;\r\n\r\nexport default table;\r\n`
        );
}

generate('zh-cn');
generate('template');
