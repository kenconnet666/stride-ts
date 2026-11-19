// CSharpIntermediate 的 UIByEditor：编辑器做的 UI 页面（一个输入框、一行字、一个按钮）。输入框的字一变就写到那行字上，
// 点按钮把两边都清掉。
import { Button, EditText, prop, StartupScript, TextBlock, UIComponent } from '@stride-ts/engine';

export class UIByEditor extends StartupScript.props({
  font: prop.asset('font').optional(),
}) {
  override start(): void {
    const root = this.entity.require(UIComponent).page?.rootElement;
    if (!root) throw new Error('UIByEditor needs the UI page on its entity');
    const textBlock = root.find(TextBlock, 'MyTextBlock')!;
    const editText = root.find(EditText, 'MyEditText')!;
    editText.addHandler(EditText.textChangedEvent, () => (textBlock.text = `My name is: ${editText.text}`));
    root.find(Button, 'MyButton')!.onClick(() => {
      editText.text = '';
      textBlock.text = '...';
    });
  }
}
