param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuaConfirmationWindow {
 [DllImport("user32.dll")]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool IsWindowVisible(IntPtr handle);
}
'@
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'CUA 应用访问确认 — 本地 MCP 桥接'
$form.ClientSize = [System.Drawing.Size]::new(800, 480)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.Tag = 'cancel'

$text = [System.Windows.Forms.TextBox]::new()
$text.Multiline = $true
$text.ReadOnly = $true
$text.ScrollBars = 'Both'
$text.WordWrap = $true
$text.SetBounds(16, 16, 768, 320)
$text.Anchor = 'Top,Bottom,Left,Right'
$details = if ($null -ne $request._meta.tool_params) { $request._meta.tool_params | ConvertTo-Json -Depth 15 } else { '(未提供参数)' }
$text.Text = "来源：本机 Codex/ChatGPT Computer Use 后端。请求由已连接的 MCP 客户端发起。`r`n`r`n$($request.message)`r`n`r`n应用 / 参数：`r`n$details"
$form.Controls.Add($text)

$note = [System.Windows.Forms.Label]::new()
$note.SetBounds(16, 344, 768, 65)
$note.Anchor = 'Bottom,Left,Right'
$note.Text = '允许全部应用：本次 MCP 会话内复用低风险应用访问授权。YOLO：自动接受本连接后续支持的 Computer Use 确认，包括更高风险请求。仅保存在内存中，重连清除；不代填未知表单或绕过 UAC。关闭、超时或中断均取消。'
$form.Controls.Add($note)

$allow = [System.Windows.Forms.Button]::new()
$allow.Text = '允许本次'
$allow.SetBounds(16, 426, 110, 36)
$allow.Anchor = 'Bottom,Right'
$allow.Add_Click({ $form.Tag = 'accept'; $form.Close() })
$form.Controls.Add($allow)
if ($request.allowSessionAll -eq $true) {
 $all = [System.Windows.Forms.Button]::new()
 $all.Text = '允许全部应用（会话）'
 $all.SetBounds(138, 426, 180, 36)
 $all.Anchor = 'Bottom,Right'
 $all.Add_Click({ $form.Tag = 'accept_all'; $form.Close() })
 $form.Controls.Add($all)
}
if ($request.allowYolo -eq $true) {
 $yolo = [System.Windows.Forms.Button]::new()
 $yolo.Text = 'YOLO：全部允许（会话）'
 $yolo.SetBounds(330, 426, 195, 36)
 $yolo.Anchor = 'Bottom,Right'
 $yolo.Add_Click({ $form.Tag = 'yolo'; $form.Close() })
 $form.Controls.Add($yolo)
}
$deny = [System.Windows.Forms.Button]::new()
$deny.Text = '拒绝'
$deny.SetBounds(538, 426, 115, 36)
$deny.Anchor = 'Bottom,Right'
$deny.Add_Click({ $form.Tag = 'decline'; $form.Close() })
$form.Controls.Add($deny)
$cancel = [System.Windows.Forms.Button]::new()
$cancel.Text = '取消'
$cancel.SetBounds(666, 426, 115, 36)
$cancel.Anchor = 'Bottom,Right'
$cancel.Add_Click({ $form.Tag = 'cancel'; $form.Close() })
$form.Controls.Add($cancel)
$form.CancelButton = $cancel
# Enter must never authorize an application by accident.
$form.AcceptButton = $cancel
$form.Add_Shown({
 $cancel.Focus() | Out-Null
 if ([CuaConfirmationWindow]::IsWindowVisible($form.Handle)) {
  [Console]::Error.WriteLine('CUA_CONFIRM_VISIBLE')
 } else {
  [Console]::Error.WriteLine('CUA_CONFIRM_HIDDEN')
  $form.Tag = 'cancel'
  $form.Close()
 }
})
try {
 $null = $form.ShowDialog()
 [Console]::Out.WriteLine([string]$form.Tag)
} finally { $form.Dispose() }
