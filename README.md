# Junction 2026: Evil Incroporated
## Main idea
make learning ASL easier, more accessible and even more fun with Rokoko's motion tracking tech!

## Technical details
Using Rokokos motion tracking gloves, based on their sdk examples we have build a data collection tool for labeling actively signed ASL letters. This is based on the rgmp architecture of documented in the sdk.
After this data gathering a Neural Network created with PyTorch has been trained, allowing us to categorize handsigns in an almost real time fashion: polling of about 0.1-0.2s. Examples of this are in the letters and teaching python files.
These are the connecting software with a Raspberry Pi 3+ controlling a 64x32 LED matrix to make the experience even more interesting. This allowed us to create the demonstration at the Rokoko stand getting text data from ASL while a robotic hand was mirroring these movements.

The communication between our components is done through http. 

A WebUI has also been made available for showing off our collected data and allowing for a small minigame in the letters.py, where following the signs on the screen keeps giving new random signs, increasing active recall.
The ui has been coauthored by Claude. It allows by external transform settings on the ```/pose``` endpoint, and calibration under ```/calbirate```. As mentioned our gathered data can be used to synthesise videos for words. 
<img width="1795" height="938" alt="image" src="https://github.com/user-attachments/assets/f1fe880f-0e9a-46b7-b0ec-0bcd6c88e2dc" />


## Possible implementations
Our product is to serve the people, allowing education and communication when it matters the most. Being able to sign can be an invaluable life skill, and our devices mostly due to the price and previous pushback arent targeting 
Due to feedback and previous pushback of similar product we don't want to target Non-verbal or Deaf individuals. Instead spreading awareness and accessability for learning to a broader audience.

## Future ideas
Increasing access to schools and communities, especially targeting hospitals where proper usage of such technologies would just improve lifes, but in cases save them too. Adding support for motioned characters of the alphabet (j and z) would be a first priority, while creating a larger labeled dataset would help other builders.
In the longer term adding proper support for full words, sentences and expressions while increasing availability of the physical arms which in our limited experience (and dreams) could be used by beginner and advanced learners alike to improve their conversational skills.

## Usage
In its current stage the set of circumstances and hardcoded ips would prevent anyone from using these out of the box. The LED matrix as common as it is, the format and connections seem to be non-standard. 
For the expansions on the examples of Rokokos-sdk they require an active license, the driver running in the background and all relevant bridges outline in their documentation under https://sdk.rokoko.com/
