import com.google.zxing.*;
import com.google.zxing.common.BitMatrix;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.Path;
import javax.imageio.ImageIO;

class MakeCodes {
    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        String[] codes = {"XERP-EMU-SINGLE", "XERP-EMU-BOX", ""};
        String[] files = {"single.png", "box.png", "blank.png"};
        for (int i = 0; i < codes.length; i++) {
            var img = new BufferedImage(640, 480, BufferedImage.TYPE_INT_RGB);
            Graphics2D g = img.createGraphics();
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 640, 480);
            if (!codes[i].isEmpty()) {
                BitMatrix qr = new MultiFormatWriter().encode(codes[i], BarcodeFormat.QR_CODE, 120, 120);
                int[][] centers = {{320, 58}, {320, 422}, {130, 240}, {320, 240}, {510, 240}};
                for (int[] center : centers) {
                    for (int y = 0; y < qr.getHeight(); y++) {
                        for (int x = 0; x < qr.getWidth(); x++) {
                            if (qr.get(x, y)) img.setRGB(center[0] + x - 60, center[1] + y - 60, 0xff000000);
                        }
                    }
                }
            }
            g.dispose();
            ImageIO.write(img, "PNG", dir.resolve(files[i]).toFile());
        }
    }
}
