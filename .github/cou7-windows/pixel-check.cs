using System;
public static class Cou7PixelCheck {
    public static string RoleMethod(bool selection, bool invoke) {
        return selection ? "selection" : invoke ? "invoke" : "keyboard";
    }
    public static string Primary(int r1,int g1,int b1,int r2,int g2,int b2) {
        if (Math.Max(Math.Max(r1,g1),b1) <= 70 && Math.Max(Math.Max(r2,g2),b2) <= 70) return "enabled";
        if (Math.Min(Math.Min(r1,g1),b1) >= 100 && Math.Min(Math.Min(r2,g2),b2) >= 100) return "disabled_or_light";
        return "unknown";
    }
}
