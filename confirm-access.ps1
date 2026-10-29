param([Parameter(Mandatory = $true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuaConfirmationWindow {
 [DllImport("user32.dll")]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("dwmapi.dll")]
 public static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);
}
'@

# The request is prepared by consent.mjs. Its text is assigned to control properties, never parsed as XAML or code.
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$seconds = 15
$grant = [string]$request.grant
$allowYolo = $request.yolo -eq $true
$defaultChoice = if ($request.defaultChoice -eq 'grant' -and $grant -eq 'app') { 'grant' } else { 'decline' }

$highContrast = [Windows.SystemParameters]::HighContrast
$light = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue).AppsUseLightTheme -ne 0
$palette = if ($highContrast) {
 $c = { param($color) $color.ToString() }
 @{ Bg = & $c ([Windows.SystemColors]::WindowColor); Surface = & $c ([Windows.SystemColors]::WindowColor); Hover = & $c ([Windows.SystemColors]::ControlColor)
    Text = & $c ([Windows.SystemColors]::WindowTextColor); Muted = & $c ([Windows.SystemColors]::WindowTextColor)
    Accent = & $c ([Windows.SystemColors]::HighlightColor); OnAccent = & $c ([Windows.SystemColors]::HighlightTextColor)
    Danger = & $c ([Windows.SystemColors]::WindowTextColor); DangerFill = & $c ([Windows.SystemColors]::HighlightColor); OnDanger = & $c ([Windows.SystemColors]::HighlightTextColor)
    Caution = & $c ([Windows.SystemColors]::WindowTextColor); Focus = & $c ([Windows.SystemColors]::HotTrackColor); Edge = & $c ([Windows.SystemColors]::WindowTextColor); EdgeWidth = '1' }
} elseif ($light) {
 @{ Bg = '#FFFFFFFF'; Surface = '#FFF3F3F3'; Hover = '#FFE6E6E6'; Text = '#FF1A1A1A'; Muted = '#FF5C5C5C'
    Accent = '#FF0B7A5E'; OnAccent = '#FFFFFFFF'; Danger = '#FFB3261E'; DangerFill = '#FFB3261E'; OnDanger = '#FFFFFFFF'
    Caution = '#FF8A5300'; Focus = '#FF1A1A1A'; Edge = '#00000000'; EdgeWidth = '0' }
} else {
 @{ Bg = '#FF202020'; Surface = '#FF2D2D2D'; Hover = '#FF383838'; Text = '#FFF5F5F5'; Muted = '#FFC4C4C4'
    Accent = '#FF4FD1A5'; OnAccent = '#FF06261C'; Danger = '#FFFF9C94'; DangerFill = '#FFFF9C94'; OnDanger = '#FF3A0B07'
    Caution = '#FFF5C451'; Focus = '#FFF5F5F5'; Edge = '#00000000'; EdgeWidth = '0' }
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Computer Use approval" Width="580" SizeToContent="Height" ResizeMode="NoResize"
        Topmost="True" WindowStartupLocation="CenterScreen" UseLayoutRounding="True"
        Background="{{Bg}}" Foreground="{{Text}}" FontSize="14"
        FontFamily="Segoe UI Variable Text, Segoe UI, Microsoft YaHei UI, Microsoft JhengHei UI">
 <Window.Resources>
  <FontFamily x:Key="Icons">Segoe Fluent Icons, Segoe MDL2 Assets</FontFamily>
  <Style x:Key="Action" TargetType="Button">
   <Setter Property="Foreground" Value="{{Text}}"/>
   <Setter Property="Background" Value="{{Surface}}"/>
   <Setter Property="BorderBrush" Value="{{Edge}}"/>
   <Setter Property="BorderThickness" Value="{{EdgeWidth}}"/>
   <Setter Property="MinWidth" Value="100"/>
   <Setter Property="MinHeight" Value="36"/>
   <Setter Property="Padding" Value="16,7"/>
   <Setter Property="Margin" Value="8,0,0,0"/>
   <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
   <Setter Property="Template">
    <Setter.Value>
     <ControlTemplate TargetType="Button">
      <Grid>
       <Border x:Name="Ring" CornerRadius="6" Margin="-3" BorderBrush="{{Focus}}" BorderThickness="2" Visibility="Hidden"/>
       <Border x:Name="Face" CornerRadius="4" Background="{TemplateBinding Background}"
               BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
        <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
       </Border>
      </Grid>
      <ControlTemplate.Triggers>
       <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Face" Property="Opacity" Value="0.88"/></Trigger>
       <Trigger Property="IsPressed" Value="True"><Setter TargetName="Face" Property="Opacity" Value="0.76"/></Trigger>
       <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Ring" Property="Visibility" Value="Visible"/></Trigger>
      </ControlTemplate.Triggers>
     </ControlTemplate>
    </Setter.Value>
   </Setter>
  </Style>
  <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Action}">
   <Setter Property="Background" Value="{{Accent}}"/>
   <Setter Property="Foreground" Value="{{OnAccent}}"/>
   <Setter Property="FontWeight" Value="SemiBold"/>
  </Style>
  <Style x:Key="Strong" TargetType="Button" BasedOn="{StaticResource Action}">
   <Setter Property="Background" Value="{{Text}}"/>
   <Setter Property="Foreground" Value="{{Bg}}"/>
   <Setter Property="FontWeight" Value="SemiBold"/>
  </Style>
  <Style x:Key="Risky" TargetType="Button" BasedOn="{StaticResource Action}">
   <Setter Property="Background" Value="Transparent"/>
   <Setter Property="Foreground" Value="{{Danger}}"/>
   <Setter Property="MinWidth" Value="0"/>
   <Setter Property="Margin" Value="0"/>
   <Setter Property="FontWeight" Value="SemiBold"/>
  </Style>
  <Style x:Key="RiskyConfirm" TargetType="Button" BasedOn="{StaticResource Action}">
   <Setter Property="Background" Value="{{DangerFill}}"/>
   <Setter Property="Foreground" Value="{{OnDanger}}"/>
   <Setter Property="FontWeight" Value="SemiBold"/>
  </Style>
  <Style x:Key="Field" TargetType="TextBox">
   <Setter Property="IsReadOnly" Value="True"/>
   <Setter Property="TextWrapping" Value="Wrap"/>
   <Setter Property="BorderThickness" Value="2"/>
   <Setter Property="BorderBrush" Value="Transparent"/>
   <Setter Property="Background" Value="Transparent"/>
   <Setter Property="Foreground" Value="{{Text}}"/>
   <Setter Property="CaretBrush" Value="{{Text}}"/>
   <Setter Property="VerticalScrollBarVisibility" Value="Auto"/>
   <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
   <Style.Triggers>
    <Trigger Property="IsKeyboardFocused" Value="True"><Setter Property="BorderBrush" Value="{{Focus}}"/></Trigger>
   </Style.Triggers>
  </Style>
 </Window.Resources>

 <Grid>
  <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
  <ScrollViewer VerticalScrollBarVisibility="Auto" Focusable="False">
   <StackPanel Margin="24,20,24,0">
    <TextBlock x:Name="Heading" FontSize="20" FontWeight="SemiBold" TextWrapping="Wrap" TextTrimming="CharacterEllipsis"
               MaxHeight="81" LineHeight="27" FontFamily="Segoe UI Variable Display, Segoe UI, Microsoft YaHei UI, Microsoft JhengHei UI"/>
    <StackPanel x:Name="RiskRow" Orientation="Horizontal" Margin="0,6,0,0" Visibility="Collapsed">
     <TextBlock x:Name="RiskIcon" Text="&#xE7BA;" FontFamily="{StaticResource Icons}" FontSize="14" VerticalAlignment="Center"/>
     <TextBlock x:Name="RiskText" Margin="8,0,0,0" FontWeight="SemiBold" VerticalAlignment="Center"/>
    </StackPanel>

    <Border Background="{{Surface}}" BorderBrush="{{Edge}}" BorderThickness="{{EdgeWidth}}" CornerRadius="4" Margin="0,16,0,0" Padding="10,8">
     <TextBox x:Name="Message" Style="{StaticResource Field}" MaxHeight="220" Padding="2"/>
    </Border>
    <Grid x:Name="Remembered" Margin="0,12,0,0" Visibility="Collapsed">
     <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
     <TextBlock Text="&#xE946;" FontFamily="{StaticResource Icons}" FontSize="14" Margin="0,3,8,0"/>
     <TextBlock Grid.Column="1" TextWrapping="Wrap" Text="Desktop may remember this decision for the conversation."/>
    </Grid>

    <Expander x:Name="Details" Header="Details" Margin="0,12,0,0" Foreground="{{Muted}}">
     <Border Background="{{Surface}}" BorderBrush="{{Edge}}" BorderThickness="{{EdgeWidth}}" CornerRadius="4" Margin="0,8,0,0" Padding="10,8">
      <TextBox x:Name="DetailsText" Style="{StaticResource Field}" Foreground="{{Muted}}" MaxHeight="180" TextWrapping="NoWrap"
               HorizontalScrollBarVisibility="Auto" FontFamily="Cascadia Mono, Consolas" FontSize="12.5"/>
     </Border>
    </Expander>
   </StackPanel>
  </ScrollViewer>

  <Grid Grid.Row="1" Margin="24,24,24,24">
   <Grid x:Name="Choices">
    <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <Button x:Name="Yolo" Style="{StaticResource Risky}" Content="YOLO&#x2026;" AutomationProperties.Name="YOLO" VerticalAlignment="Bottom"/>
    <StackPanel Grid.Column="1" Orientation="Horizontal" HorizontalAlignment="Right">
     <Button x:Name="Decline" Style="{StaticResource Action}"><TextBlock x:Name="DeclineLabel"/></Button>
     <Button x:Name="Once" Style="{StaticResource Action}" Content="Allow once"/>
     <Button x:Name="Grant" Style="{StaticResource Action}"><TextBlock x:Name="GrantLabel"/></Button>
    </StackPanel>
   </Grid>

   <StackPanel x:Name="YoloConfirm" Visibility="Collapsed">
    <Grid>
     <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
     <TextBlock Text="&#xE7BA;" FontFamily="{StaticResource Icons}" FontSize="16" Foreground="{{Danger}}" Margin="0,2,10,0"/>
     <TextBlock Grid.Column="1" TextWrapping="Wrap" FontWeight="SemiBold"
                Text="Accept supported app and site requests, including high risk, until you reconnect."/>
    </Grid>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
     <Button x:Name="Back" Style="{StaticResource Action}" Content="Back"/>
     <Button x:Name="YoloOn" Style="{StaticResource RiskyConfirm}" Content="Turn on YOLO"/>
    </StackPanel>
   </StackPanel>
  </Grid>
 </Grid>
</Window>
'@
foreach ($key in $palette.Keys) { $xaml = $xaml.Replace("{{$key}}", $palette[$key]) }
$window = [Windows.Markup.XamlReader]::Parse($xaml)
$ui = @{}
foreach ($name in 'Heading','RiskRow','RiskIcon','RiskText','Message','Remembered','Details','DetailsText','Choices','Yolo','Decline','DeclineLabel',
  'Once','Grant','GrantLabel','YoloConfirm','Back','YoloOn') { $ui[$name] = $window.FindName($name) }
$brush = { param($color) [Windows.Media.BrushConverter]::new().ConvertFromString($color) }
$window.MaxHeight = [Windows.SystemParameters]::WorkArea.Height * 0.92

$ui.Heading.Text = [string]$request.title
$ui.Heading.ToolTip = [string]$request.title
$ui.Message.Text = [string]$request.message
$ui.DetailsText.Text = [string]$request.details
if ($request.remembered -eq $true) { $ui.Remembered.Visibility = 'Visible' }
if ($request.risk -eq 'high' -or $request.risk -eq 'medium') {
 $ui.RiskRow.Visibility = 'Visible'
 $ui.RiskText.Text = if ($request.risk -eq 'high') { 'High risk' } else { 'Medium risk' }
 $color = & $brush $(if ($request.risk -eq 'high') { $palette.Danger } else { $palette.Caution })
 $ui.RiskText.Foreground = $color
 $ui.RiskIcon.Foreground = $color
}
$labels = @{ Decline = 'Decline'; Grant = 'Allow until reconnect' }
$ui.DeclineLabel.Text = $labels.Decline
$ui.GrantLabel.Text = $labels.Grant
if ($grant -eq 'app' -or $grant -eq 'site') {
 [Windows.Automation.AutomationProperties]::SetName($ui.Grant, "Allow this $grant until you reconnect")
} else { $ui.Grant.Visibility = 'Collapsed' }
if (-not $allowYolo) { $ui.Yolo.Visibility = 'Collapsed' }

# The default choice is the highlighted button and names its countdown; YOLO is never a default.
$defaultName = if ($defaultChoice -eq 'grant') { 'Grant' } else { 'Decline' }
$defaultButton = $ui[$defaultName]
$defaultLabel = $ui["${defaultName}Label"]
$defaultButton.Style = $window.FindResource($(if ($defaultName -eq 'Grant') { 'Primary' } else { 'Strong' }))
$defaultButton.IsDefault = $true
$defaultLabel.Text = "$($labels[$defaultName]) in ${seconds}s"

$script:choice = 'cancel'
$script:deadline = $null
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
function Stop-Countdown { $timer.Stop(); $defaultLabel.Text = $labels[$defaultName] }
function Choose([string]$value) { $script:choice = $value; $timer.Stop(); $window.Close() }

$ui.Decline.Add_Click({ Choose 'decline' })
$ui.Once.Add_Click({ Choose 'accept' })
$ui.Grant.Add_Click({ Choose 'grant' })
$ui.YoloOn.Add_Click({ Choose 'yolo' })
$ui.Yolo.Add_Click({
 Stop-Countdown
 $defaultButton.IsDefault = $false
 $ui.Choices.Visibility = 'Collapsed'
 $ui.YoloConfirm.Visibility = 'Visible'
 $null = $ui.Back.Focus()
})
$ui.Back.Add_Click({
 $ui.YoloConfirm.Visibility = 'Collapsed'
 $ui.Choices.Visibility = 'Visible'
 $null = $ui.Yolo.Focus()
})
$ui.Details.Add_Expanded({ Stop-Countdown })
$window.Add_PreviewKeyDown({ param($sender, $e) if ($e.Key -eq 'Escape') { $e.Handled = $true; Choose 'cancel' } })
$timer.Add_Tick({
 $left = [Math]::Max(0, [Math]::Ceiling(($script:deadline - [DateTime]::UtcNow).TotalSeconds))
 $defaultLabel.Text = "$($labels[$defaultName]) in ${left}s"
 if ($left -le 0) { Choose $defaultChoice }
})
$window.Add_SourceInitialized({
 $dark = [int](-not $light -and -not $highContrast)
 $null = [CuaConfirmationWindow]::DwmSetWindowAttribute([Windows.Interop.WindowInteropHelper]::new($window).Handle, 20, [ref]$dark, 4)
})
$window.Add_ContentRendered({
 if (-not [CuaConfirmationWindow]::IsWindowVisible([Windows.Interop.WindowInteropHelper]::new($window).Handle)) {
  [Console]::Error.WriteLine('CUA_CONFIRM_HIDDEN')
  $window.Close()
  return
 }
 [Console]::Error.WriteLine('CUA_CONFIRM_VISIBLE')
 $null = $window.Activate()
 $null = $defaultButton.Focus()
 $script:deadline = [DateTime]::UtcNow.AddSeconds($seconds)
 $timer.Start()
})

$null = $window.ShowDialog()
[Console]::Out.WriteLine($script:choice)
