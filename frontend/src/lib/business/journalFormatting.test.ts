import {expect,test} from 'bun:test';
import {journalCodeBlock} from './journalFormatting';
test('imported code cannot close its own fenced block',()=>{
 expect(journalCodeBlock('const text = "```";', 'js')).toBe('````js\nconst text = "```";\n````');
 expect(journalCodeBlock('<script>alert(1)</script>', '\nhtml')).toBe('```\n<script>alert(1)</script>\n```');
});
