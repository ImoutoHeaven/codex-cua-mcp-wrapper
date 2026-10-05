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
}
'@
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$seconds = 15
$app = [string]$request._meta.tool_params.app
$allowApp = $request.allowApp -eq $true -and $app
$allowYolo = $request.allowYolo -eq $true

$light = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue).AppsUseLightTheme -eq 1
$palette = if ($light) {
 @{ Bg = '#FFFFFFFF'; Surface = '#FFF5F5F7'; Edge = '#16000000'; Text = '#FF18181B'; Muted = '#FF6B6B76'
    Accent = '#FF0E9C78'; AccentEdge = '#FF0B8466'; Accent2 = '#FF14B8A6'; Danger = '#FFDC2626'; DangerEdge = '#55DC2626'
    Chip = '#0D000000'; Track = '#12000000'; Glow = '#1F10A37F'; Shadow = '0.22'; Focus = '#FF0E9C78' }
} else {
 @{ Bg = '#FF1F1F23'; Surface = '#FF27272D'; Edge = '#1FFFFFFF'; Text = '#FFF4F4F5'; Muted = '#FFA1A1AA'
    Accent = '#FF10A37F'; AccentEdge = '#FF19C08F'; Accent2 = '#FF34D399'; Danger = '#FFF87171'; DangerEdge = '#59F87171'
    Chip = '#17FFFFFF'; Track = '#1AFFFFFF'; Glow = '#3310A37F'; Shadow = '0.55'; Focus = '#FF6EE7B7' }
}

# Request data is assigned to control properties below, never interpolated into XAML.
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Computer Use access confirmation" Width="600" SizeToContent="Height"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
        Topmost="True" WindowStartupLocation="CenterScreen" UseLayoutRounding="True"
        FontFamily="Segoe UI Variable Text, Microsoft YaHei UI, Segoe UI" FontSize="13" Foreground="{{Text}}">
 <Window.Resources>
  <FontFamily x:Key="Icons">Segoe Fluent Icons, Segoe MDL2 Assets</FontFamily>
  <Style x:Key="Btn" TargetType="Button">
   <Setter Property="Foreground" Value="{{Text}}"/>
   <Setter Property="Background" Value="{{Surface}}"/>
   <Setter Property="BorderBrush" Value="{{Edge}}"/>
   <Setter Property="BorderThickness" Value="1"/>
   <Setter Property="Padding" Value="16,0"/>
   <Setter Property="Height" Value="36"/>
   <Setter Property="Cursor" Value="Hand"/>
   <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
   <Setter Property="Template">
    <Setter.Value>
     <ControlTemplate TargetType="Button">
      <Grid x:Name="Root" RenderTransformOrigin="0.5,0.5">
       <Grid.RenderTransform><ScaleTransform/></Grid.RenderTransform>
       <Border x:Name="Ring" CornerRadius="11" Margin="-3" BorderBrush="{{Focus}}" BorderThickness="2" Opacity="0"/>
       <Border CornerRadius="8" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"/>
       <Border x:Name="Wash" CornerRadius="8" Background="{TemplateBinding Foreground}" Opacity="0"/>
       <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Grid>
      <ControlTemplate.Triggers>
       <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Wash" Property="Opacity" Value="0.09"/></Trigger>
       <Trigger Property="IsPressed" Value="True">
        <Setter TargetName="Wash" Property="Opacity" Value="0.16"/>
        <Setter TargetName="Root" Property="RenderTransform"><Setter.Value><ScaleTransform ScaleX="0.97" ScaleY="0.97"/></Setter.Value></Setter>
       </Trigger>
       <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Ring" Property="Opacity" Value="1"/></Trigger>
      </ControlTemplate.Triggers>
     </ControlTemplate>
    </Setter.Value>
   </Setter>
  </Style>
  <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Btn}">
   <Setter Property="Foreground" Value="#FFFFFFFF"/>
   <Setter Property="BorderBrush" Value="{{AccentEdge}}"/>
   <Setter Property="FontWeight" Value="SemiBold"/>
   <Setter Property="Background">
    <Setter.Value>
     <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
      <GradientStop Color="{{AccentEdge}}" Offset="0"/>
      <GradientStop Color="{{Accent}}" Offset="1"/>
     </LinearGradientBrush>
    </Setter.Value>
   </Setter>
  </Style>
  <Style x:Key="Danger" TargetType="Button" BasedOn="{StaticResource Btn}">
   <Setter Property="Foreground" Value="{{Danger}}"/>
   <Setter Property="Background" Value="Transparent"/>
   <Setter Property="BorderBrush" Value="{{DangerEdge}}"/>
   <Setter Property="Padding" Value="12,0,14,0"/>
  </Style>
  <Style x:Key="Ghost" TargetType="Button" BasedOn="{StaticResource Btn}">
   <Setter Property="Foreground" Value="{{Muted}}"/>
   <Setter Property="Background" Value="Transparent"/>
   <Setter Property="BorderThickness" Value="0"/>
   <Setter Property="Padding" Value="8,0"/>
   <Setter Property="Height" Value="30"/>
  </Style>
  <Style x:Key="Chip" TargetType="Border">
   <Setter Property="CornerRadius" Value="9"/>
   <Setter Property="Padding" Value="8,2,9,3"/>
   <Setter Property="Background" Value="{{Chip}}"/>
  </Style>
 </Window.Resources>

 <Grid Margin="28">
  <Border x:Name="Card" CornerRadius="16" Background="{{Bg}}" BorderBrush="{{Edge}}" BorderThickness="1"
          Opacity="0" RenderTransformOrigin="0.5,0.5">
   <Border.RenderTransform>
    <TransformGroup>
     <ScaleTransform x:Name="CardScale" ScaleX="0.96" ScaleY="0.96"/>
     <TranslateTransform x:Name="CardShift" Y="14"/>
    </TransformGroup>
   </Border.RenderTransform>
   <Border.Effect><DropShadowEffect BlurRadius="40" ShadowDepth="12" Direction="270" Opacity="{{Shadow}}" Color="#FF000000"/></Border.Effect>
   <Grid>
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Border Grid.RowSpan="2" Height="150" VerticalAlignment="Top" CornerRadius="16,16,0,0" IsHitTestVisible="False">
     <Border.Background>
      <RadialGradientBrush Center="0.12,0" GradientOrigin="0.12,0" RadiusX="0.75" RadiusY="1.1">
       <GradientStop Color="{{Glow}}" Offset="0"/>
       <GradientStop Color="#00000000" Offset="1"/>
      </RadialGradientBrush>
     </Border.Background>
    </Border>

    <Grid Margin="24,22,14,0">
     <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
     <Border x:Name="Badge" Width="50" Height="50" CornerRadius="15" VerticalAlignment="Top">
      <Border.Background>
       <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
        <GradientStop Color="#FF34D399" Offset="0"/>
        <GradientStop Color="#FF10A37F" Offset="0.5"/>
        <GradientStop Color="#FF0E7490" Offset="1"/>
       </LinearGradientBrush>
      </Border.Background>
      <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="5" Direction="270" Opacity="0.4" Color="#FF10A37F"/></Border.Effect>
      <TextBlock x:Name="BadgeGlyph" Text="&#xEA18;" FontFamily="{StaticResource Icons}" FontSize="23" Foreground="#FFFFFFFF"
                 HorizontalAlignment="Center" VerticalAlignment="Center"/>
     </Border>
     <StackPanel Grid.Column="1" Margin="16,0,8,0" VerticalAlignment="Center">
      <TextBlock Text="COMPUTER USE · ACCESS REQUEST" FontSize="11" FontWeight="SemiBold" Foreground="{{Muted}}"/>
      <TextBlock x:Name="AppName" FontSize="21" FontWeight="SemiBold" Margin="0,1,0,0" TextTrimming="CharacterEllipsis"
                 FontFamily="Segoe UI Variable Display, Microsoft YaHei UI, Segoe UI"/>
      <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
       <Border x:Name="RiskChip" Style="{StaticResource Chip}">
        <StackPanel Orientation="Horizontal">
         <Ellipse x:Name="RiskDot" Width="6" Height="6" Margin="0,1,6,0" VerticalAlignment="Center"/>
         <TextBlock x:Name="RiskText" FontSize="11.5" FontWeight="SemiBold"/>
        </StackPanel>
       </Border>
       <Border Style="{StaticResource Chip}" Margin="6,0,0,0">
        <StackPanel Orientation="Horizontal">
         <TextBlock Text="&#xE71B;" FontFamily="{StaticResource Icons}" FontSize="10" Foreground="{{Muted}}" Margin="0,1,6,0" VerticalAlignment="Center"/>
         <TextBlock Text="Local MCP bridge" FontSize="11.5" Foreground="{{Muted}}"/>
        </StackPanel>
       </Border>
      </StackPanel>
     </StackPanel>
     <Button x:Name="CloseButton" Grid.Column="2" Style="{StaticResource Ghost}" Width="32" Height="32" Padding="0"
             VerticalAlignment="Top" ToolTip="Cancel (Esc)">
      <TextBlock Text="&#xE8BB;" FontFamily="{StaticResource Icons}" FontSize="10"/>
     </Button>
    </Grid>

    <StackPanel Grid.Row="1" Margin="24,18,24,0">
     <Border Background="{{Surface}}" BorderBrush="{{Edge}}" BorderThickness="1" CornerRadius="10" Padding="16,12">
      <ScrollViewer MaxHeight="150" VerticalScrollBarVisibility="Auto">
       <TextBlock x:Name="Message" TextWrapping="Wrap" FontSize="13.5" LineHeight="21"/>
      </ScrollViewer>
     </Border>
     <Button x:Name="Toggle" Style="{StaticResource Ghost}" HorizontalAlignment="Left" Margin="-8,8,0,0">
      <StackPanel Orientation="Horizontal">
       <TextBlock Text="&#xE76C;" FontFamily="{StaticResource Icons}" FontSize="9" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.5">
        <TextBlock.RenderTransform><RotateTransform x:Name="Chevron"/></TextBlock.RenderTransform>
       </TextBlock>
       <TextBlock Text="Request parameters" Margin="8,0,0,1" FontSize="12"/>
      </StackPanel>
     </Button>
     <Border x:Name="Details" Visibility="Collapsed" Background="{{Surface}}" BorderBrush="{{Edge}}" BorderThickness="1"
             CornerRadius="10" Margin="0,4,0,0" Padding="4">
      <TextBox x:Name="DetailsText" IsReadOnly="True" BorderThickness="0" Background="Transparent" Foreground="{{Muted}}"
               CaretBrush="{{Text}}" SelectionBrush="{{Accent}}" FontFamily="Cascadia Mono, Consolas" FontSize="12"
               Padding="10,6" MaxHeight="160" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Auto"/>
     </Border>
    </StackPanel>

    <StackPanel Grid.Row="2" Margin="24,14,24,22">
     <TextBlock x:Name="Hint" Height="36" TextWrapping="Wrap" FontSize="12" LineHeight="18" Foreground="{{Muted}}"/>
     <Border Height="3" CornerRadius="1.5" Background="{{Track}}" Margin="0,6,0,16">
      <Border x:Name="Bar" CornerRadius="1.5" RenderTransformOrigin="0,0.5">
       <Border.RenderTransform><ScaleTransform x:Name="BarScale"/></Border.RenderTransform>
       <Border.Background>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
         <GradientStop Color="{{Accent}}" Offset="0"/>
         <GradientStop Color="{{Accent2}}" Offset="1"/>
        </LinearGradientBrush>
       </Border.Background>
      </Border>
     </Border>
     <Grid>
      <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <Button x:Name="Yolo" Style="{StaticResource Danger}" AutomationProperties.Name="YOLO">
       <StackPanel Orientation="Horizontal">
        <TextBlock Text="&#xE945;" FontFamily="{StaticResource Icons}" FontSize="13" VerticalAlignment="Center" Margin="0,1,6,0"/>
        <TextBlock Text="YOLO" FontWeight="SemiBold"/>
       </StackPanel>
      </Button>
      <StackPanel Grid.Column="2" Orientation="Horizontal">
       <Button x:Name="Deny" Style="{StaticResource Btn}" AutomationProperties.Name="Decline">
        <StackPanel Orientation="Horizontal">
         <TextBlock Text="Decline"/>
         <Border x:Name="DenyChip" Style="{StaticResource Chip}" Visibility="Collapsed" Margin="8,0,-6,0" Padding="6,0,6,1" MinWidth="24">
          <TextBlock x:Name="DenyCount" FontSize="11.5" HorizontalAlignment="Center"/>
         </Border>
        </StackPanel>
       </Button>
       <Button x:Name="Once" Style="{StaticResource Btn}" Content="Allow once" Margin="8,0,0,0"/>
       <Button x:Name="App" Style="{StaticResource Primary}" Margin="8,0,0,0" AutomationProperties.Name="Allow this app">
        <StackPanel Orientation="Horizontal">
         <TextBlock Text="Allow this app"/>
         <Border x:Name="AppChip" Style="{StaticResource Chip}" Visibility="Collapsed" Background="#30FFFFFF" Margin="8,0,-6,0" Padding="6,0,6,1" MinWidth="24">
          <TextBlock x:Name="AppCount" FontSize="11.5" HorizontalAlignment="Center"/>
         </Border>
        </StackPanel>
       </Button>
      </StackPanel>
     </Grid>
    </StackPanel>
   </Grid>
  </Border>
 </Grid>
</Window>
'@
foreach ($key in $palette.Keys) { $xaml = $xaml.Replace("{{$key}}", $palette[$key]) }
$window = [Windows.Markup.XamlReader]::Parse($xaml)
$ui = @{}
foreach ($name in 'Badge','BadgeGlyph','Card','CardScale','CardShift','AppName','RiskChip','RiskDot','RiskText','CloseButton','Message','Toggle','Chevron',
  'Details','DetailsText','Hint','Bar','BarScale','Yolo','Deny','DenyChip','DenyCount','Once','App','AppChip','AppCount') {
 $ui[$name] = $window.FindName($name)
}
$brush = { param($color) [Windows.Media.BrushConverter]::new().ConvertFromString($color) }

$ui.AppName.Text = if ($app) { $app } else { 'Computer Use' }
$ui.Message.Text = [string]$request.message
$ui.DetailsText.Text = if ($null -ne $request._meta.tool_params) { $request._meta.tool_params | ConvertTo-Json -Depth 15 } else { '(no parameters)' }
$risk = switch ([string]$request._meta.riskLevel) {
 'low' { 'Low risk', $(if ($light) { '15803D' } else { '4ADE80' }) }
 'medium' { 'Medium risk', $(if ($light) { 'B45309' } else { 'FBBF24' }) }
 'high' { 'High risk', $(if ($light) { 'DC2626' } else { 'F87171' }) }
 default { 'Unknown risk', $(if ($light) { '6B6B76' } else { 'A1A1AA' }) }
}
$ui.RiskText.Text = $risk[0]
$ui.RiskText.Foreground = & $brush "#FF$($risk[1])"
$ui.RiskDot.Fill = & $brush "#FF$($risk[1])"
$ui.RiskChip.Background = & $brush "#24$($risk[1])"
if ($request._meta.riskLevel -eq 'high') {
 $warm = [Windows.Media.GradientStopCollection]::new()
 foreach ($stop in @('#FFFBBF24', 0), @('#FFF97316', 0.5), @('#FFDC2626', 1)) { $warm.Add([Windows.Media.GradientStop]::new([Windows.Media.ColorConverter]::ConvertFromString($stop[0]), $stop[1])) }
 $ui.Badge.Background = [Windows.Media.LinearGradientBrush]::new($warm, 45)
 $ui.Badge.Effect.Color = [Windows.Media.ColorConverter]::ConvertFromString('#FFF97316')
 $ui.BadgeGlyph.Text = [char]0xE7BA
}

$target = if ($app) { $app } else { 'this app' }
$hints = @{
 Deny = 'Decline this request without granting any access.'
 Once = 'Allow only this request; the next one asks again.'
 App = "Automatically allow further low-risk access to $target for this connection; reconnecting clears it."
 Yolo = 'Automatically accept every supported Computer Use confirmation for this connection, including high-risk requests. Use only for trusted tasks.'
}
if ($allowApp) {
 $default = 'accept_app'; $defaultButton = $ui.App; $chip = $ui.AppChip; $count = $ui.AppCount
 $idleHint = "When the countdown ends, further low-risk access to $target is allowed for this connection. Press Esc to cancel."
} else {
 $default = 'decline'; $defaultButton = $ui.Deny; $chip = $ui.DenyChip; $count = $ui.DenyCount
 $ui.App.Visibility = 'Collapsed'
 $ui.Bar.Background = & $brush $palette.Muted
 $idleHint = 'When the countdown ends, this request is declined. Press Esc to cancel.'
}
if (-not $allowYolo) { $ui.Yolo.Visibility = 'Collapsed' }
$chip.Visibility = 'Visible'
$count.Text = [string]$seconds
$defaultButton.IsDefault = $true
$ui.Hint.Text = $idleHint

$script:choice = 'cancel'
$script:closing = $false
$script:deadline = [DateTime]::UtcNow
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(200)

function Animate($target, $property, $from, $to, $ms, $ease) {
 $duration = [Windows.Duration]::new([TimeSpan]::FromMilliseconds($ms))
 $animation = if ($null -eq $from) { [Windows.Media.Animation.DoubleAnimation]::new($to, $duration) }
  else { [Windows.Media.Animation.DoubleAnimation]::new($from, $to, $duration) }
 if ($ease) { $animation.EasingFunction = [Windows.Media.Animation.CubicEase]@{ EasingMode = $ease } }
 $target.BeginAnimation($property, $animation)
 $animation
}
function Choose([string]$value) {
 if ($script:closing) { return }
 $script:closing = $true
 $script:choice = $value
 $timer.Stop()
 $fade = [Windows.Media.Animation.DoubleAnimation]::new(0, [Windows.Duration]::new([TimeSpan]::FromMilliseconds(130)))
 $fade.Add_Completed({ $window.Close() })
 $ui.Card.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
 $null = Animate $ui.CardScale ([Windows.Media.ScaleTransform]::ScaleXProperty) 1 0.97 130 'EaseIn'
 $null = Animate $ui.CardScale ([Windows.Media.ScaleTransform]::ScaleYProperty) 1 0.97 130 'EaseIn'
}

$ui.Deny.Add_Click({ Choose 'decline' })
$ui.Once.Add_Click({ Choose 'accept' })
$ui.App.Add_Click({ Choose 'accept_app' })
$ui.Yolo.Add_Click({ Choose 'yolo' })
$ui.CloseButton.Add_Click({ Choose 'cancel' })
foreach ($name in $hints.Keys) {
 $text = $hints[$name]
 $show = { $ui.Hint.Text = $text }.GetNewClosure()
 $ui[$name].Add_MouseEnter($show)
 $ui[$name].Add_GotKeyboardFocus($show)
 $ui[$name].Add_MouseLeave({ $ui.Hint.Text = $idleHint })
 $ui[$name].Add_LostKeyboardFocus({ $ui.Hint.Text = $idleHint })
}
$ui.Toggle.Add_Click({
 $open = $ui.Details.Visibility -ne 'Visible'
 $ui.Details.Visibility = if ($open) { 'Visible' } else { 'Collapsed' }
 $null = Animate $ui.Chevron ([Windows.Media.RotateTransform]::AngleProperty) $null $(if ($open) { 90 } else { 0 }) 160 'EaseOut'
})
$ui.Card.Add_MouseLeftButtonDown({ $window.DragMove() })
$window.Add_PreviewKeyDown({ param($sender, $e) if ($e.Key -eq 'Escape') { $e.Handled = $true; Choose 'cancel' } })
$timer.Add_Tick({
 $left = ($script:deadline - [DateTime]::UtcNow).TotalSeconds
 $count.Text = [string][Math]::Max(0, [Math]::Ceiling($left))
 if ($left -le 0) { Choose $default }
})
$window.Add_ContentRendered({
 if (-not [CuaConfirmationWindow]::IsWindowVisible([Windows.Interop.WindowInteropHelper]::new($window).Handle)) {
  [Console]::Error.WriteLine('CUA_CONFIRM_HIDDEN')
  $window.Close()
  return
 }
 [Console]::Error.WriteLine('CUA_CONFIRM_VISIBLE')
 $window.Activate() | Out-Null
 $null = Animate $ui.Card ([Windows.UIElement]::OpacityProperty) 0 1 220 'EaseOut'
 $null = Animate $ui.CardScale ([Windows.Media.ScaleTransform]::ScaleXProperty) 0.96 1 320 'EaseOut'
 $null = Animate $ui.CardScale ([Windows.Media.ScaleTransform]::ScaleYProperty) 0.96 1 320 'EaseOut'
 $null = Animate $ui.CardShift ([Windows.Media.TranslateTransform]::YProperty) 14 0 320 'EaseOut'
 $null = Animate $ui.BarScale ([Windows.Media.ScaleTransform]::ScaleXProperty) 1 0 ($seconds * 1000) $null
 $script:deadline = [DateTime]::UtcNow.AddSeconds($seconds)
 $timer.Start()
})

$null = $window.ShowDialog()
[Console]::Out.WriteLine($script:choice)
